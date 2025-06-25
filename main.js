import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import stonehengeObjUrl from './stonehenge_sm.obj?url';
import { highlightVertexShader, highlightFragmentShader, extrusionVertexShader, extrusionFragmentShader } from './shaders.js';

// --- Configuration ---
const CONFIG = {
    showBothGeometries: true, // Set to true to show both dummy geometry and imported mesh
    numExtrusions: 120,       // Number of shadow extrusions to generate
    extrusionInterval: 0.125,  // Time interval between extrusions
    baseHour: 4,              // Starting hour for sun position
    minOpacity: 0.001,        // Minimum opacity when sun is at horizon
    maxOpacity: 0.03,         // Maximum opacity when sun is directly overhead
    extrusionDistance: 30,   // Length of shadow extrusion
    progressiveExtrusions: true, // Whether to add extrusions progressively
    progressiveDelay: 0,      // Milliseconds between adding each extrusion
    showFpsCounter: true      // Whether to show the FPS counter
};

// --- Materials and Geometry Constants ---
const dummyGeometry = new THREE.BoxGeometry(1, 3, 2, 40, 20, 80);
const baseMeshMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    //color: 0x999999,
    metalness: 0.2,
    roughness: 0.04,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: 1,
    //flatShading: true,
    //wireframe: true
});

// --- Global variables ---
let importedObjMesh = null;
let dummyMesh = null;

//Calculate sun direction vector based on time and location
function getSunDirection(hour, latitude = 51.178844, longitude = -1.826323, dateInput = new Date(2025, 4, 21)){
    // Convert input parameters to radians and calculate Julian date
    const lat = THREE.MathUtils.degToRad(latitude);
    const lon = THREE.MathUtils.degToRad(longitude);
    const date = new Date(dateInput);
    
    // Calculate Julian Day
    const year = date.getFullYear();
    const month = date.getMonth() + 1; // JS months are 0-based
    const day = date.getDate();
    
    let jd = 367 * year - Math.floor(7 * (year + Math.floor((month + 9) / 12)) / 4) +
             Math.floor(275 * month / 9) + day + 1721013.5 + hour / 24;
    
    // Calculate Julian centuries since J2000.0
    const jc = (jd - 2451545.0) / 36525.0;
    
    // Calculate solar mean anomaly (degrees)
    const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
    const Mrad = THREE.MathUtils.degToRad(M);
    
    // Calculate mean longitude of the Sun (degrees)
    let L0 = 280.46646 + jc * (36000.76983 + jc * 0.0003032);
    L0 = L0 % 360;
    if (L0 < 0) L0 += 360;
    
    // Calculate equation of center (degrees)
    const C = (1.914602 - jc * (0.004817 + 0.000014 * jc)) * Math.sin(Mrad) +
              (0.019993 - 0.000101 * jc) * Math.sin(2 * Mrad) +
              0.000289 * Math.sin(3 * Mrad);
    
    // Calculate true longitude of the Sun (degrees)
    const L = L0 + C;
    
    // Calculate Earth's orbital eccentricity
    const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
    
    // Calculate the Sun's apparent radius vector (distance)
    const R = 1.000001018 * (1 - e * e) / (1 + e * Math.cos(THREE.MathUtils.degToRad(M + C)));
    
    // Calculate the obliquity of the ecliptic (degrees)
    let epsilon = 23.43929111 - jc * (0.01300417 + jc * (0.00000289 - jc * 0.00000002));
    
    // Convert Sun's longitude and obliquity to radians
    const Lrad = THREE.MathUtils.degToRad(L);
    const epsilonRad = THREE.MathUtils.degToRad(epsilon);
    
    // Calculate right ascension and declination (radians)
    const ra = Math.atan2(Math.cos(epsilonRad) * Math.sin(Lrad), Math.cos(Lrad));
    const dec = Math.asin(Math.sin(epsilonRad) * Math.sin(Lrad));
    
    // Calculate Greenwich Mean Sidereal Time (degrees)
    const GMST = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 
                 jc * jc * (0.000387933 - jc / 38710000.0);
    
    // Normalize GMST to range [0, 360)
    const GMSTnorm = GMST % 360;
    const GMSTdeg = GMSTnorm < 0 ? GMSTnorm + 360 : GMSTnorm;
    
    // Calculate Local Sidereal Time (degrees)
    const LST = (GMSTdeg + THREE.MathUtils.radToDeg(lon)) % 360;
    const LSTrad = THREE.MathUtils.degToRad(LST);
    
    // Calculate hour angle (radians)
    const ha = LSTrad - ra;
    
    // Calculate altitude and azimuth (radians)
    const sinAlt = Math.sin(lat) * Math.sin(dec) + 
                   Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
    const alt = Math.asin(sinAlt);
    
    // Calculate azimuth (radians), measured from south increasing towards west
    // Converting to standard coordinate system where azimuth is from North increasing eastward
    const cosAz = (Math.sin(dec) - Math.sin(alt) * Math.sin(lat)) / 
                  (Math.cos(alt) * Math.cos(lat));
    const sinAz = -Math.sin(ha) * Math.cos(dec) / Math.cos(alt);
    const az = Math.atan2(sinAz, cosAz);
    
    // Convert altitude and azimuth to Cartesian coordinates
    const y = Math.sin(alt);  // Up direction
    const r = Math.cos(alt);  // Horizontal component
    const x = r * Math.sin(az);  // East-west component
    const z = r * Math.cos(az);  // North-south component
    
    // Return the normalized direction vector
    return new THREE.Vector3(x, y, z).normalize();
}

// --- Render Target Pool -- -
// Manages a pool of WebGLRenderTargets to reduce allocation overhead.
const renderTargetPool = {
    available: [],
    inUse: [],
    
    // Get a render target from the pool or create a new one if none are available
    get: function(width, height, options) {
        let target;
        if (this.available.length > 0) {
            target = this.available.pop();
            target.setSize(width, height); // Ensure size is correct
        } else {
            target = new THREE.WebGLRenderTarget(width, height, options);
        }
        this.inUse.push(target);
        return target;
    },

    // Release a render target back to the available pool
    release: function(target) {
        const index = this.inUse.indexOf(target);
        if (index > -1) {
            this.inUse.splice(index, 1);
            this.available.push(target);
        }
    },

    // Dispose of all render targets held in the pool
    disposeAll: function() {
        this.available.forEach(target => target.dispose());
        this.inUse.forEach(target => target.dispose());
        this.available = [];
        this.inUse = [];
    }
};


// --- Scene Setup ---
function setupScene() {
    // Create scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);
    
    // Create camera
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 40, 40);
    
    // Create renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);
    
    // Create stats
    let stats = null;
    if (CONFIG.showFpsCounter) {
        stats = new Stats();
        stats.dom.style.position = 'absolute';
        document.body.appendChild(stats.dom);
    }
    
    // Create controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    
    // Create ground
    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(1000, 1000),
        new THREE.MeshBasicMaterial({ 
            color: 0xffffff,
            side: THREE.DoubleSide 
        })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.5;
    scene.add(ground);

    // Add a north arrow
    //const arrowDirection = new THREE.Vector3(0, 0, -1).normalize();
    //const arrowOrigin = new THREE.Vector3(0, 0.1, 0);
    //const arrowLength = 2;
    //const arrowColor = 0x008000;
    //const arrowHeadSize = .5;
    //const northArrow = new THREE.ArrowHelper(arrowDirection, arrowOrigin, arrowLength, arrowColor, arrowHeadSize);
    //scene.add(northArrow);

    return { scene, camera, renderer, controls, stats };
}

//Load the OBJ model file
function loadOBJ() {
    const loader = new OBJLoader();
    const objMaterial = new THREE.MeshStandardMaterial({
        color: 0xFFFFFF,
        metalness: 0.5,
        roughness: 0.5,
    });

    return new Promise((resolve, reject) => {
        loader.load(
            stonehengeObjUrl,
            (object) => {
                object.traverse((child) => {
                    if (child.isMesh) {
                        // Create a new geometry with morphAttributes
                        const geometry = new THREE.BufferGeometry();
                        geometry.setAttribute('position', child.geometry.getAttribute('position'));
                        if (child.geometry.getAttribute('normal')) {
                            geometry.setAttribute('normal', child.geometry.getAttribute('normal'));
                        }
                        if (child.geometry.getAttribute('uv')) {
                            geometry.setAttribute('uv', child.geometry.getAttribute('uv'));
                        }
                        
                        // Scale the geometry vertices directly
                        const positions = geometry.getAttribute('position');
                        const scale = 0.0001;
                        for (let i = 0; i < positions.count; i++) {
                            positions.setXYZ(
                                i,
                                positions.getX(i) * scale,
                                positions.getY(i) * scale - 1.5,
                                positions.getZ(i) * scale
                            );
                        }
                        geometry.attributes.position.needsUpdate = true;
                        
                        // Create a new mesh with the scaled geometry
                        const mesh = new THREE.Mesh(geometry, objMaterial);
                        importedObjMesh = mesh;
                        resolve(mesh);
                    }
                });
                console.log('OBJ file loaded successfully');
            },
            (xhr) => {
                console.log((xhr.loaded / xhr.total) * 100 + '% loaded');
            },
            (error) => {
                console.error('An error occurred while loading the OBJ file:', error);
                reject(error);
            }
        );
    });
}

// --- Shadow Geometry Generation ---
function generateExtrudedMesh(baseGeometry, sunDir, distance, positionOffset = new THREE.Vector3(0, 0, 0)) {
    // Early exit for sun below horizon
    if (sunDir.y <= 0) return null;

    const positions = baseGeometry.getAttribute('position').array;
    const normalsAttribute = baseGeometry.getAttribute('normal');

    if (!normalsAttribute) {
        console.warn("generateExtrudedMesh: Base geometry is missing normals. Cannot generate extrusion.");
        return null;
    }
    const normals = normalsAttribute.array;
    const indices = baseGeometry.index ? baseGeometry.index.array : null;

    const totalFaces = indices ? indices.length / 3 : positions.length / 9; // 9 = 3 vertices/face * 3 coords/vertex
    const PRECISION = 1000; // For vertex deduplication (4 decimal places)

    const uniqueFaceVertices = []; // Stores unique {x,y,z} of sun-facing faces' vertices
    const sunFacingFaceIndices = [];    // Indices for the sun-facing faces (triplets, referencing uniqueFaceVertices)
    
    // Use nested Maps for numerical keys
    // For vertexMap: Map<roundedX, Map<roundedY, Map<roundedZ, index>>>
    const vertexMap = new Map();
    // For boundaryEdges: Map<minIndex, Map<maxIndex, { count, vA, vB }>>
    const boundaryEdges = new Map();

    // Reusable Vector3 instances to reduce allocations in the main loop
    const tempNormalA = new THREE.Vector3();
    const tempNormalB = new THREE.Vector3();
    const tempNormalC = new THREE.Vector3();
    const tempFaceNormal = new THREE.Vector3();

    const addUniqueVertex = (originalVertexIndex) => {
        const x = positions[originalVertexIndex * 3] + positionOffset.x;
        const y = positions[originalVertexIndex * 3 + 1] + positionOffset.y;
        const z = positions[originalVertexIndex * 3 + 2] + positionOffset.z;
        
        const rx = Math.round(x * PRECISION);
        const ry = Math.round(y * PRECISION);
        const rz = Math.round(z * PRECISION);

        let mapY = vertexMap.get(rx);
        if (!mapY) {
            mapY = new Map();
            vertexMap.set(rx, mapY);
        }
        let mapZ = mapY.get(ry);
        if (!mapZ) {
            mapZ = new Map();
            mapY.set(ry, mapZ);
        }

        if (!mapZ.has(rz)) {
            const newIndex = uniqueFaceVertices.length / 3;
            mapZ.set(rz, newIndex);
            uniqueFaceVertices.push(x, y, z); // Store offset vertex coordinates
            return newIndex;
        }
        return mapZ.get(rz);
    };

    // v1UniqueIdx and v2UniqueIdx are indices into the 'uniqueFaceVertices' array
    const addBoundaryEdge = (v1UniqueIdx, v2UniqueIdx) => {
        const minIdx = Math.min(v1UniqueIdx, v2UniqueIdx);
        const maxIdx = Math.max(v1UniqueIdx, v2UniqueIdx);

        let mapMaxIdx = boundaryEdges.get(minIdx);
        if (!mapMaxIdx) {
            mapMaxIdx = new Map();
            boundaryEdges.set(minIdx, mapMaxIdx);
        }

        const edgeData = mapMaxIdx.get(maxIdx);
        if (edgeData) {
            edgeData.count++;
        } else {
            // Store original v1UniqueIdx and v2UniqueIdx as vA and vB
            mapMaxIdx.set(maxIdx, { count: 1, vA: v1UniqueIdx, vB: v2UniqueIdx });
        }
    };

    for (let i = 0; i < totalFaces; i++) {
        const faceVertexIndexBase = i * 3;
        const origVAIdx = indices ? indices[faceVertexIndexBase]     : faceVertexIndexBase;
        const origVBIdx = indices ? indices[faceVertexIndexBase + 1] : faceVertexIndexBase + 1;
        const origVCIdx = indices ? indices[faceVertexIndexBase + 2] : faceVertexIndexBase + 2;

        tempNormalA.fromArray(normals, origVAIdx * 3);
        tempNormalB.fromArray(normals, origVBIdx * 3);
        tempNormalC.fromArray(normals, origVCIdx * 3);
        tempFaceNormal.copy(tempNormalA).add(tempNormalB).add(tempNormalC).normalize();

        if (tempFaceNormal.dot(sunDir) > 0.01) { // Face is sun-facing
            const uniqueVA = addUniqueVertex(origVAIdx);
            const uniqueVB = addUniqueVertex(origVBIdx);
            const uniqueVC = addUniqueVertex(origVCIdx);

            sunFacingFaceIndices.push(uniqueVA, uniqueVB, uniqueVC);

            addBoundaryEdge(uniqueVA, uniqueVB);
            addBoundaryEdge(uniqueVB, uniqueVC);
            addBoundaryEdge(uniqueVC, uniqueVA);
        }
    }

    if (uniqueFaceVertices.length === 0) return null; // No sun-facing geometry

    const offsetVec = sunDir.clone().multiplyScalar(-distance);
    
    const finalVerticesArray = new Float32Array(uniqueFaceVertices.length * 2);
    finalVerticesArray.set(uniqueFaceVertices); 
    let currentFinalVertexCount = uniqueFaceVertices.length / 3;

    const finalIndicesArray = [];
    sunFacingFaceIndices.forEach(idx => finalIndicesArray.push(idx));

    const originalToExtrudedVertexMap = new Map(); 

    // Iterate over the nested boundaryEdges map
    boundaryEdges.forEach((mapMaxIdx) => {
        mapMaxIdx.forEach((edgeData) => {
            if (edgeData.count === 1) { // This is a silhouette edge
                const origUniqueA = edgeData.vA; // Index in uniqueFaceVertices (original, not minIdx)
                const origUniqueB = edgeData.vB; // Index in uniqueFaceVertices (original, not maxIdx)

                let extrudedA_finalIdx, extrudedB_finalIdx;

                if (!originalToExtrudedVertexMap.has(origUniqueA)) {
                    extrudedA_finalIdx = currentFinalVertexCount;
                    originalToExtrudedVertexMap.set(origUniqueA, extrudedA_finalIdx);
                    const baseVertexOffset = origUniqueA * 3;
                    const targetVertexOffset = extrudedA_finalIdx * 3;
                    finalVerticesArray[targetVertexOffset]     = uniqueFaceVertices[baseVertexOffset]     + offsetVec.x;
                    finalVerticesArray[targetVertexOffset + 1] = uniqueFaceVertices[baseVertexOffset + 1] + offsetVec.y;
                    finalVerticesArray[targetVertexOffset + 2] = uniqueFaceVertices[baseVertexOffset + 2] + offsetVec.z;
                    currentFinalVertexCount++;
                } else {
                    extrudedA_finalIdx = originalToExtrudedVertexMap.get(origUniqueA);
                }

                if (!originalToExtrudedVertexMap.has(origUniqueB)) {
                    extrudedB_finalIdx = currentFinalVertexCount;
                    originalToExtrudedVertexMap.set(origUniqueB, extrudedB_finalIdx);
                    const baseVertexOffset = origUniqueB * 3;
                    const targetVertexOffset = extrudedB_finalIdx * 3;
                    finalVerticesArray[targetVertexOffset]     = uniqueFaceVertices[baseVertexOffset]     + offsetVec.x;
                    finalVerticesArray[targetVertexOffset + 1] = uniqueFaceVertices[baseVertexOffset + 1] + offsetVec.y;
                    finalVerticesArray[targetVertexOffset + 2] = uniqueFaceVertices[baseVertexOffset + 2] + offsetVec.z;
                    currentFinalVertexCount++;
                } else {
                    extrudedB_finalIdx = originalToExtrudedVertexMap.get(origUniqueB);
                }

                finalIndicesArray.push(origUniqueA, origUniqueB, extrudedA_finalIdx);
                finalIndicesArray.push(origUniqueB, extrudedB_finalIdx, extrudedA_finalIdx);
            }
        });
    });
    
    const finalVertexPositions = finalVerticesArray.slice(0, currentFinalVertexCount * 3);

    const extrudedGeo = new THREE.BufferGeometry();
    extrudedGeo.setAttribute('position', new THREE.Float32BufferAttribute(finalVertexPositions, 3));
    extrudedGeo.setIndex(new THREE.Uint32BufferAttribute(new Uint32Array(finalIndicesArray), 1));
    
    return extrudedGeo;
}

// --- Rendering Setup ---
function setupMultipassRendering(scene, camera, renderer, meshData, baseMeshes) {
    // Ensure baseMeshes is always an array
    const meshArray = Array.isArray(baseMeshes) ? baseMeshes : [baseMeshes];
    // Get renderer size
    const size = new THREE.Vector2();
    renderer.getSize(size);

    // --- Optimization: Use a more efficient format if alpha is not needed for blending ---
    const renderTargetOptions = {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBFormat // Use RGBFormat to reduce memory bandwidth
    };
    
    // --- Optimization: Use Render Target Pool ---
    const baseTarget = renderTargetPool.get(size.x, size.y, renderTargetOptions);
    
    // Arrays to store rendering resources
    const extrusionTargets = [];
    const extrusionQuads = [];
    const extrusionMeshes = [];

    // --- Optimization: Shared geometry for all screen quads ---
    const sharedQuadGeometry = new THREE.PlaneGeometry(2, 2);

    // Template material for extrusion quads
    const templateExtrusionQuadMaterial = new THREE.ShaderMaterial({
        uniforms: {
            tDiffuse: { value: null }, // Will be set per instance
            opacity: { value: 0.0 },    // Will be set per instance
            extrusionColor: { value: new THREE.Vector3() } // Will be set per instance
        },
        vertexShader: extrusionVertexShader,
        fragmentShader: extrusionFragmentShader,
        transparent: true,
        blending: THREE.NormalBlending
    });
    
    // If not using progressive extrusions, initialize all targets at once
    if (!CONFIG.progressiveExtrusions) {
        meshData.forEach(() => {
            // --- Optimization: Use Render Target Pool ---
            extrusionTargets.push(renderTargetPool.get(size.x, size.y, renderTargetOptions));
        });
    }
    
    // Material that renders any mesh as pure red
    const highlightMaterial = new THREE.ShaderMaterial({
        vertexShader: highlightVertexShader,
        fragmentShader: highlightFragmentShader,
        side: THREE.DoubleSide
    });
    
    // Create a separate scene for composition
    const compositionScene = new THREE.Scene();
    const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    // Create the base quad
    const baseQuadMaterial = new THREE.MeshBasicMaterial({
        map: baseTarget.texture,
        transparent: false
    });
    
    const baseQuad = new THREE.Mesh(
        sharedQuadGeometry, // --- Optimization: Use shared geometry ---
        baseQuadMaterial
    );
    baseQuad.frustumCulled = false;
    compositionScene.add(baseQuad);
    
    // Function to calculate opacity based on sun altitude
    function calculateOpacity(sunAltitude) {
        // Linear interpolation between min and max opacity based on sun altitude
        return CONFIG.minOpacity + sunAltitude * (CONFIG.maxOpacity - CONFIG.minOpacity);
    }
    
    // Create quad for an extrusion
    function createExtrusionQuad(target, meshIndex, sunDirection, extrusionIndex) {
        const material = templateExtrusionQuadMaterial.clone();

        // Use extrusionIndex for color calculation to maintain time-based gradient
        const hue = extrusionIndex / CONFIG.numExtrusions;
        const color = new THREE.Color().setHSL(hue, 1.0, 0.5);
        const sunAltitude = sunDirection ? Math.max(0, sunDirection.y) : 0;

        material.uniforms.tDiffuse.value = target.texture;
        material.uniforms.opacity.value = calculateOpacity(sunAltitude);
        material.uniforms.extrusionColor.value.set(color.r, color.g, color.b);
        
        const quad = new THREE.Mesh(sharedQuadGeometry, material); // --- Optimization: Use shared geometry ---
        quad.frustumCulled = false;
        compositionScene.add(quad);
        return quad;
    }
    
    // If not using progressive extrusions, create all quads and meshes at once
    if (!CONFIG.progressiveExtrusions) {
        meshData.forEach(({ geometry, sunDirection, extrusionIndex }, arrayIndex) => {
            const quad = createExtrusionQuad(extrusionTargets[arrayIndex], arrayIndex, sunDirection, extrusionIndex);
            extrusionQuads.push(quad);
            
            const mesh = new THREE.Mesh(geometry, highlightMaterial);
            extrusionMeshes.push(mesh);
        });
    }
    
    return {
        addExtrusion: function(geometry, sunDirection, extrusionIndex) {
            const index = extrusionTargets.length;
            
            // --- Optimization: Use Render Target Pool ---
            const target = renderTargetPool.get(size.x, size.y, renderTargetOptions);
            extrusionTargets.push(target);
            
            const quad = createExtrusionQuad(target, index, sunDirection, extrusionIndex);
            extrusionQuads.push(quad);
            
            const mesh = new THREE.Mesh(geometry, highlightMaterial);
            extrusionMeshes.push(mesh);
        },
        render: function() {
            // Add all base meshes to scene
            meshArray.forEach(mesh => {
                if (mesh) scene.add(mesh);
            });
            renderer.setRenderTarget(baseTarget);
            renderer.render(scene, camera);
            
            extrusionMeshes.forEach((mesh, i) => {
                scene.add(mesh);
                renderer.setRenderTarget(extrusionTargets[i]);
                renderer.render(scene, camera);
                scene.remove(mesh);
            });
            
            renderer.setRenderTarget(null);
            renderer.render(compositionScene, orthoCamera);
            
            // Remove all base meshes from scene
            meshArray.forEach(mesh => {
                if (mesh) scene.remove(mesh);
            });
        },
        setOpacity: function() {
            extrusionQuads.forEach((quad, index) => {
                if (index < meshData.length && meshData[index] && meshData[index].sunDirection) {
                    const sunAltitude = Math.max(0, meshData[index].sunDirection.y);
                    quad.material.uniforms.opacity.value = calculateOpacity(sunAltitude);
                }
            });
        },
        resize: function() {
            renderer.getSize(size);
            baseTarget.setSize(size.x, size.y);
            extrusionTargets.forEach(target => target.setSize(size.x, size.y));
        },
        dispose: function() {
            // Release all render targets back to pool
            renderTargetPool.release(baseTarget);
            extrusionTargets.forEach(target => renderTargetPool.release(target));
            
            // Dispose materials and shared geometry
            highlightMaterial.dispose();
            baseQuadMaterial.dispose();
            templateExtrusionQuadMaterial.dispose();
            sharedQuadGeometry.dispose(); 

            extrusionQuads.forEach(quad => {
                quad.material.dispose(); // Each cloned material instance needs disposal
            });
            extrusionMeshes.forEach(mesh => {
                if (mesh.geometry) mesh.geometry.dispose(); // These are unique extrusion geometries
            });
        }
    };
}

// --- Animation and Main Loop ---
function animate(scene, camera, renderer, controls, sunLight, stats) {
    const meshData = [];
    let extrusionIndex = 0;

    // Create dummy mesh
    dummyMesh = new THREE.Mesh(dummyGeometry, baseMeshMaterial.clone());
    dummyMesh.position.set(-5, 0, 0); // Position dummy mesh to the left

    // Wait for OBJ to load
    if (!importedObjMesh) {
        requestAnimationFrame(() => animate(scene, camera, renderer, controls, sunLight, stats));
        return;
    }

    // Position imported mesh to the right
    importedObjMesh.position.set(5, 0, 0);
    importedObjMesh.material = baseMeshMaterial.clone();

    // Add both meshes to scene if configured to show both
    if (CONFIG.showBothGeometries) {
        scene.add(dummyMesh);
        scene.add(importedObjMesh);
    } else {
        // For backwards compatibility, add just the imported mesh
        scene.add(importedObjMesh);
    }

    let multipass;

    if (CONFIG.progressiveExtrusions) {
        // Start with empty meshData for progressive mode
        const meshesToRender = CONFIG.showBothGeometries ? [dummyMesh, importedObjMesh] : [importedObjMesh];
        multipass = setupMultipassRendering(scene, camera, renderer, meshData, meshesToRender);
        console.log("Starting progressive extrusion generation...");
    } else {
        // Generate all extrusions at once for non-progressive mode
        console.time('Mesh Generation');
        let skippedCount = 0;

        for (let i = 0; i < CONFIG.numExtrusions; i++) {
            const sunDirForExtrusion = getSunDirection(CONFIG.baseHour + i * CONFIG.extrusionInterval);
            
            // Generate extrusions for both geometries if showing both
            if (CONFIG.showBothGeometries) {
                // Generate for dummy geometry
                const dummyExtrudedGeometry = generateExtrudedMesh(dummyGeometry, sunDirForExtrusion, CONFIG.extrusionDistance, dummyMesh.position);
                if (dummyExtrudedGeometry) {
                    meshData.push({ 
                        geometry: dummyExtrudedGeometry,
                        sunDirection: sunDirForExtrusion,
                        sourceObject: 'dummy',
                        extrusionIndex: i
                    });
                }

                // Generate for imported geometry
                const objExtrudedGeometry = generateExtrudedMesh(importedObjMesh.geometry, sunDirForExtrusion, CONFIG.extrusionDistance, importedObjMesh.position);
                if (objExtrudedGeometry) {
                    meshData.push({ 
                        geometry: objExtrudedGeometry,
                        sunDirection: sunDirForExtrusion,
                        sourceObject: 'imported',
                        extrusionIndex: i
                    });
                }
            } else {
                // Original behavior - just imported mesh
                const extrudedGeometry = generateExtrudedMesh(importedObjMesh.geometry, sunDirForExtrusion, CONFIG.extrusionDistance, importedObjMesh.position);
                if (extrudedGeometry) {
                    meshData.push({ 
                        geometry: extrudedGeometry,
                        sunDirection: sunDirForExtrusion,
                        extrusionIndex: i
                    });
                } else {
                    skippedCount++;
                }
            }
        }

        console.log(`Skipped ${skippedCount} extrusions due to sun below horizon`);
        console.timeEnd('Mesh Generation');

        // Initialize multipass rendering with all meshData
        const meshesToRender = CONFIG.showBothGeometries ? [dummyMesh, importedObjMesh] : [importedObjMesh];
        multipass = setupMultipassRendering(scene, camera, renderer, meshData, meshesToRender);
        multipass.setOpacity();
    }

    // Function to add the next extrusion
    function addNextExtrusion() {
        if (extrusionIndex >= CONFIG.numExtrusions) {
            return; // All extrusions have been added
        }

        const sunDirForExtrusion = getSunDirection(CONFIG.baseHour + extrusionIndex * CONFIG.extrusionInterval);
        
        if (CONFIG.showBothGeometries) {
            // Add extrusions for both geometries
            const dummyExtrudedGeometry = generateExtrudedMesh(dummyGeometry, sunDirForExtrusion, CONFIG.extrusionDistance, dummyMesh.position);
            if (dummyExtrudedGeometry) {
                meshData.push({ 
                    geometry: dummyExtrudedGeometry,
                    sunDirection: sunDirForExtrusion,
                    sourceObject: 'dummy',
                    extrusionIndex: extrusionIndex
                });
                multipass.addExtrusion(dummyExtrudedGeometry, sunDirForExtrusion, extrusionIndex);
            }

            const objExtrudedGeometry = generateExtrudedMesh(importedObjMesh.geometry, sunDirForExtrusion, CONFIG.extrusionDistance, importedObjMesh.position);
            if (objExtrudedGeometry) {
                meshData.push({ 
                    geometry: objExtrudedGeometry,
                    sunDirection: sunDirForExtrusion,
                    sourceObject: 'imported',
                    extrusionIndex: extrusionIndex
                });
                multipass.addExtrusion(objExtrudedGeometry, sunDirForExtrusion, extrusionIndex);
            }
        } else {
            // Original behavior
            const extrudedGeometry = generateExtrudedMesh(importedObjMesh.geometry, sunDirForExtrusion, CONFIG.extrusionDistance, importedObjMesh.position);
            if (extrudedGeometry) {
                meshData.push({ 
                    geometry: extrudedGeometry,
                    sunDirection: sunDirForExtrusion,
                    extrusionIndex: extrusionIndex
                });
                multipass.addExtrusion(extrudedGeometry, sunDirForExtrusion, extrusionIndex);
            }
        }

        extrusionIndex++;
        
        // Schedule the next extrusion
        if (extrusionIndex < CONFIG.numExtrusions) {
            setTimeout(addNextExtrusion, CONFIG.progressiveDelay);
        } else {
            console.log(`Completed extrusion generation. Created ${meshData.length} extrusions.`);
        }
    }

    // Start adding extrusions if in progressive mode
    if (CONFIG.progressiveExtrusions) {
        addNextExtrusion();
    }

    function render() {
        requestAnimationFrame(render);
        if (stats) stats.update();
        multipass.render();
        controls.update();
    }

    // Handle window resize
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        multipass.resize();
    });

    render();
}

async function main() {
    const { scene, camera, renderer, controls, stats } = setupScene();

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
    scene.add(sunLight);

    try {
        // Always load the OBJ file since we want to show both geometries
        await loadOBJ();
        animate(scene, camera, renderer, controls, sunLight, stats);
    } catch (error) {
        console.error('Failed to load OBJ:', error);
        // If OBJ fails to load, we could fall back to just dummy geometry
        // For now, we'll keep the error handling as is
    } finally {
        // --- Cleanup ---
        // Ensure all pooled render targets are disposed when the app closes or reloads
        window.addEventListener('beforeunload', () => {
            renderTargetPool.disposeAll();
        });
    }
}

// Start the application
main();