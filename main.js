import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import stonehengeObjUrl from './stonehenge_sm.obj?url';
import { highlightVertexShader, highlightFragmentShader, extrusionVertexShader, extrusionFragmentShader } from './shaders.js';
import { GPUExtruder } from './GPUExtruder.js'; // Import the new module

// --- Global variables for throttling console logging ---
let lastLogTime = 0;
const LOG_THROTTLE_MS = 2000; // Only log every 2 seconds

// --- Configuration ---
const CONFIG = {
    showDummyMesh: false,      // Whether to show the dummy geometry mesh
    showImportedMesh: true,   // Whether to show the imported mesh
    numExtrusions: 80,       // Number of shadow extrusions to generate
    extrusionInterval: 0.25,  // Time interval between extrusions
    baseHour: 4,              // Starting hour for sun position
    minOpacity: 0.001,        // Minimum opacity when sun is at horizon
    maxOpacity: 0.05,         // Maximum opacity when sun is directly overhead
    extrusionDistance: 10,   // Length of shadow extrusion
    showFpsCounter: true,     // Whether to show the FPS counter
    week: 21,                 // Week of the year for solar calculations (1-52, where 21 is mid-May)
    day: 147,                 // Day of the year for solar calculations (1-365, where 147 is mid-May)
    showAllMonths: false,      // Whether to show all solar positions throughout the year
    // Solar coverage configuration (used when showAllMonths is true)
    dayInterval: 7,           // Show extrusions for every nth day (7 = weekly sampling)
    hourIntervalMinutes: 80,  // Time interval between extrusions in minutes
    offsetMinutes: 22,        // Offset in minutes so sequential days don't show exact same hours
    // Animation configuration
    animateDay: true,         // Whether to animate through days of the year
    animationSpeed: 2         // Number of frames per day change (higher = slower animation)
};

// --- Materials and Geometry Constants ---
const dummyGeometry = new THREE.BoxGeometry(1, 3, 2, 40, 20, 80);
const baseMeshMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    //color: 0x999999,
    //metalness: 0.2,
    //roughness: 0.04,
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

// --- Calculate scaled extrusion distance based on sun altitude ---
function getScaledExtrusionDistance(sunDirection, baseDistance) {
    // sunDirection.altitude is in radians, 0 = horizon, π/2 = zenith
    const altitude = sunDirection.altitude || 0;
    const maxAltitude = Math.PI / 2; // 90 degrees in radians
    
    // Normalize altitude to 0-1 range (0 = horizon, 1 = zenith)
    const normalizedAltitude = Math.max(0, altitude) / maxAltitude;
    
    // Scale factor: when sun is high (altitude = 1), distance is halved (factor = 0.5)
    // when sun is low (altitude = 0), distance is full (factor = 1)
    const scaleFactor = 1 - (normalizedAltitude * 0.99);
    
    return baseDistance * scaleFactor;
}

//Calculate sun direction vector based on time and location
function getSunDirection(hour, latitude = 51.178844, longitude = -1.826323, dayOfYear = CONFIG.day){
    // Convert input parameters to radians and calculate Julian date
    const lat = THREE.MathUtils.degToRad(latitude);
    const lon = THREE.MathUtils.degToRad(longitude);
    
    // Calculate date from day of year (assuming 2025)
    const year = 2025;
    const januaryFirst = new Date(year, 0, 1);
    const date = new Date(januaryFirst.getTime() + (dayOfYear - 1) * 24 * 60 * 60 * 1000);
    
    // Calculate Julian Day
    const dateYear = date.getFullYear();
    const dateMonth = date.getMonth() + 1; // JS months are 0-based
    const day = date.getDate();
    
    let jd = 367 * dateYear - Math.floor(7 * (dateYear + Math.floor((dateMonth + 9) / 12)) / 4) +
             Math.floor(275 * dateMonth / 9) + day + 1721013.5 + hour / 24;
    
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
    
    // Store the altitude for more accurate horizon checks
    const sunData = new THREE.Vector3(x, y, z).normalize();
    sunData.altitude = alt; // Store altitude in radians for accurate horizon checking
    
    // Return the normalized direction vector with altitude data
    return sunData;
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
    camera.position.set(20, 20, 20);
    
    // --- Combined touch and user agent test for manual resolution halving ---
    const isTouch = (
        ('ontouchstart' in window || navigator.maxTouchPoints > 0) &&
        /Mobi|Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    );
    let width = window.innerWidth;
    let height = window.innerHeight;
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    if (isTouch) {
        renderer.setSize(width / 2, height / 2, false); // halve internal resolution
        renderer.domElement.style.width = width + 'px'; // scale up to fill screen
        renderer.domElement.style.height = height + 'px';
    } else {
        renderer.setSize(width, height);
    }
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
            //side: THREE.DoubleSide 
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
// The CPU-based generateExtrudedMesh function has been removed.

// --- Rendering Setup ---
function setupMultipassRendering(scene, camera, renderer, meshData, baseMeshes) {
    // Ensure baseMeshes is always an array
    const meshArray = Array.isArray(baseMeshes) ? baseMeshes : [baseMeshes];
    // Get renderer size
    const size = new THREE.Vector2();
    renderer.getSize(size);

    // --- Optimization: Use a more efficient format if alpha is not needed for blending ---
    const renderTargetOptions = {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: THREE.RGBFormat // Use RGBFormat to reduce memory bandwidth
    };
    
    // --- Optimization: Use Render Target Pool ---
    const baseTarget = renderTargetPool.get(size.x, size.y, renderTargetOptions);
    
    // Map to group meshes by sun direction - key is sun direction string, value is array of meshes
    const sunDirectionGroups = new Map();
    // Arrays to store rendering resources
    const extrusionTargets = [];
    const extrusionQuads = [];

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
    
    // Helper function to create a unique key for sun direction grouping
    function getSunDirectionKey(sunDirection) {
        // Round to reasonable precision to group similar sun directions
        const precision = 1000;
        return `${Math.round(sunDirection.x * precision)}_${Math.round(sunDirection.y * precision)}_${Math.round(sunDirection.z * precision)}`;
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
    
    // Create quad for an extrusion group
    function createExtrusionQuad(target, groupData) {
        const material = templateExtrusionQuadMaterial.clone();

        // Use colorIndex for color calculation - this creates daily gradients in "show all year" mode
        const hue = groupData.colorIndex;
        const color = new THREE.Color().setHSL(hue, 1.0, 0.5);
        const sunAltitude = groupData.sunDirection ? Math.max(0, groupData.sunDirection.y) : 0;

        material.uniforms.tDiffuse.value = target.texture;
        material.uniforms.opacity.value = calculateOpacity(sunAltitude);
        material.uniforms.extrusionColor.value.set(color.r, color.g, color.b);
        
        const quad = new THREE.Mesh(sharedQuadGeometry, material); // --- Optimization: Use shared geometry ---
        quad.frustumCulled = false;
        compositionScene.add(quad);
        return quad;
    }
    
    return {
        processExistingMeshes: function(meshDataArray) {
            console.log(`Processing ${meshDataArray.length} extrusion meshes for grouping`);
            meshDataArray.forEach(extrusionObject => {
                const { mesh, sunDirection, extrusionIndex, colorIndex } = extrusionObject;
                const key = getSunDirectionKey(sunDirection); //can be replaced without key
                
                // Check if we already have a group for this sun direction
                if (!sunDirectionGroups.has(key)) {
                    // Create new group
                    const groupData = {
                        sunDirection: sunDirection,
                        meshes: [mesh],
                        extrusionIndex: extrusionIndex,
                        colorIndex: colorIndex
                    };
                    sunDirectionGroups.set(key, groupData);
                    
                    // Create render target and quad for this new group
                    const target = renderTargetPool.get(size.x, size.y, renderTargetOptions);
                    extrusionTargets.push(target);
                    
                    const quad = createExtrusionQuad(target, groupData);
                    extrusionQuads.push(quad);
                    //console.log(`Created new group for sun direction key: ${key}, group has ${groupData.meshes.length} meshes`);
                } else {
                    // Add mesh to existing group
                    sunDirectionGroups.get(key).meshes.push(mesh);
                    //console.log(`Added mesh to existing group ${key}, group now has ${sunDirectionGroups.get(key).meshes.length} meshes`);
                }
            });
            //console.log(`Created ${sunDirectionGroups.size} sun direction groups with ${extrusionTargets.length} render targets`);
        },
        render: function() {
            // Add all base meshes to scene
            meshArray.forEach(mesh => {
                if (mesh) scene.add(mesh);
            });
            renderer.setRenderTarget(baseTarget);
            renderer.render(scene, camera);
            
            // Render each sun direction group together
            let targetIndex = 0;
            sunDirectionGroups.forEach((groupData) => {
                // Add all meshes for this sun direction to the scene at once
                groupData.meshes.forEach(mesh => scene.add(mesh));
                
                // Render all meshes for this sun direction in one pass
                renderer.setRenderTarget(extrusionTargets[targetIndex]);
                renderer.render(scene, camera);
                
                // Remove all meshes for this sun direction from the scene
                groupData.meshes.forEach(mesh => scene.remove(mesh));
                
                targetIndex++;
            });
            
            renderer.setRenderTarget(null);
            renderer.render(compositionScene, orthoCamera);
            
            // Remove all base meshes from scene
            meshArray.forEach(mesh => {
                if (mesh) scene.remove(mesh);
            });
        },
        setOpacity: function() {
            let quadIndex = 0;
            sunDirectionGroups.forEach((groupData) => {
                if (quadIndex < extrusionQuads.length) {
                    const sunAltitude = Math.max(0, groupData.sunDirection.y);
                    extrusionQuads[quadIndex].material.uniforms.opacity.value = calculateOpacity(sunAltitude);
                    quadIndex++;
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
            
            // Dispose geometries from all meshes in sun direction groups
            sunDirectionGroups.forEach((groupData) => {
                groupData.meshes.forEach(mesh => {
                    if (mesh.geometry) mesh.geometry.dispose(); // These are unique extrusion geometries
                });
            });
        }
    };
}

// --- Animation and Main Loop ---
function animate(scene, camera, renderer, controls, sunLight, stats) {
    const meshData = [];
    let dummyExtruder, objExtruder;
    let multipass;

    // Create dummy mesh
    dummyMesh = new THREE.Mesh(dummyGeometry, baseMeshMaterial.clone());
    dummyMesh.position.set(-5, 0, 0);
    scene.add(dummyMesh);

    // Create imported mesh
    importedObjMesh.position.set(5, 0, 0);
    importedObjMesh.material = baseMeshMaterial.clone();

    // Prepare the extruders for GPU extrusion
    console.log("Using GPU-based extrusion.");
    // The geometry needs normals for this technique
    if (!dummyGeometry.getAttribute('normal')) dummyGeometry.computeVertexNormals();
    if (!importedObjMesh.geometry.getAttribute('normal')) importedObjMesh.geometry.computeVertexNormals();

    dummyExtruder = new GPUExtruder(dummyGeometry);
    objExtruder = new GPUExtruder(importedObjMesh.geometry);

    // Add meshes to scene based on configuration
    if (CONFIG.showImportedMesh) {
        scene.add(importedObjMesh);
    }
    if (!CONFIG.showDummyMesh) {
        scene.remove(dummyMesh);
    }

    // Function to generate extrusion meshes
    function generateExtrusions() {
        // Clear existing mesh data
        meshData.length = 0;
        
        // Throttle console.time for performance logging
        const currentTime = Date.now();
        const shouldLog = currentTime - lastLogTime > LOG_THROTTLE_MS;
        if (shouldLog) {
            console.time('Mesh Generation');
        }
        let skippedCount = 0;

        if (CONFIG.showAllMonths) {
            // Generate extrusions with configurable day and hour intervals for better solar coverage
            let extrusionIndex = 0;
            
            // Calculate how many days we'll sample (365 days / dayInterval)
            const totalDays = 365;
            const daysSampled = Math.ceil(totalDays / CONFIG.dayInterval);
            
            for (let dayIndex = 0; dayIndex < daysSampled; dayIndex++) {
                const dayOfYear = dayIndex * CONFIG.dayInterval + 1; // Start from day 1
                
                // Calculate offset for this day to stagger the hours
                const dayOffset = (dayIndex * CONFIG.offsetMinutes) % (24 * 60); // Wrap around after 24 hours
                
                // Calculate how many time samples we'll take this day
                const dayStartMinutes = 0 * 60; // Start at midnight (0 minutes)
                const dayEndMinutes = 24 * 60;  // End at midnight next day (1440 minutes)
                const dayDurationMinutes = dayEndMinutes - dayStartMinutes;
                const timeSamples = Math.floor(dayDurationMinutes / CONFIG.hourIntervalMinutes) + 1;
                
                for (let timeIndex = 0; timeIndex < timeSamples; timeIndex++) {
                    // Calculate the time of day in minutes, with offset
                    const baseTimeMinutes = dayStartMinutes + (timeIndex * CONFIG.hourIntervalMinutes);
                    const offsetTimeMinutes = (baseTimeMinutes + dayOffset) % (24 * 60);
                    const hour = offsetTimeMinutes / 60; // Convert back to decimal hours
                    
                    const sunDirForExtrusion = getSunDirection(hour, 51.178844, -1.826323, dayOfYear);
                    
                    if (sunDirForExtrusion.y > 0) { // Only add if sun is above horizon
                        // Calculate color index based on time within the day for "show all year" mode
                        // Since we now cover the full 24-hour day, no wrapping adjustment needed
                        const timeProgress = offsetTimeMinutes / dayDurationMinutes; // 0 to 1 through the day
                        const colorIndex = CONFIG.showAllMonths ? timeProgress : extrusionIndex;
                        
                        if (CONFIG.showDummyMesh) {
                            // GPU Path for dummy mesh
                            const scaledDistance = getScaledExtrusionDistance(sunDirForExtrusion, CONFIG.extrusionDistance);
                            const dummyExtrusionMesh = dummyExtruder.createMesh(sunDirForExtrusion, scaledDistance);
                            dummyExtrusionMesh.position.copy(dummyMesh.position);
                            dummyExtrusionMesh.rotation.copy(dummyMesh.rotation);
                            meshData.push({ 
                                mesh: dummyExtrusionMesh, 
                                sunDirection: sunDirForExtrusion, 
                                extrusionIndex: extrusionIndex,
                                colorIndex: colorIndex,
                                dayOfYear: dayOfYear,
                                timeProgress: timeProgress
                            });
                        }
                        
                        if (CONFIG.showImportedMesh) {
                            // GPU Path for imported mesh
                            const scaledDistance = getScaledExtrusionDistance(sunDirForExtrusion, CONFIG.extrusionDistance);
                            const objExtrusionMesh = objExtruder.createMesh(sunDirForExtrusion, scaledDistance);
                            objExtrusionMesh.position.copy(importedObjMesh.position);
                            objExtrusionMesh.rotation.copy(importedObjMesh.rotation);
                            meshData.push({ 
                                mesh: objExtrusionMesh, 
                                sunDirection: sunDirForExtrusion, 
                                extrusionIndex: extrusionIndex,
                                colorIndex: colorIndex,
                                dayOfYear: dayOfYear,
                                timeProgress: timeProgress
                            });
                        }
                        extrusionIndex++;
                    } else {
                        skippedCount++;
                    }
                }
            }
        } else {
            // Original single day mode
            for (let i = 0; i < CONFIG.numExtrusions; i++) {
                const sunDirForExtrusion = getSunDirection(CONFIG.baseHour + i * CONFIG.extrusionInterval, 51.178844, -1.826323, CONFIG.day);
                
                if (sunDirForExtrusion.y > 0) {
                    // For single week mode, use the traditional linear color indexing
                    const colorIndex = i / CONFIG.numExtrusions;
                    
                    if (CONFIG.showDummyMesh) {
                        // GPU Path for dummy mesh
                        const scaledDistance = getScaledExtrusionDistance(sunDirForExtrusion, CONFIG.extrusionDistance);
                        const dummyExtrusionMesh = dummyExtruder.createMesh(sunDirForExtrusion, scaledDistance);
                        dummyExtrusionMesh.position.copy(dummyMesh.position);
                        dummyExtrusionMesh.rotation.copy(dummyMesh.rotation);
                        meshData.push({ 
                            mesh: dummyExtrusionMesh, 
                            sunDirection: sunDirForExtrusion, 
                            extrusionIndex: i,
                            colorIndex: colorIndex,
                            dayOfYear: null,
                            timeProgress: null
                        });
                    }
                    
                    if (CONFIG.showImportedMesh) {
                        // GPU Path for imported mesh
                        const scaledDistance = getScaledExtrusionDistance(sunDirForExtrusion, CONFIG.extrusionDistance);
                        const objExtrusionMesh = objExtruder.createMesh(sunDirForExtrusion, scaledDistance);
                        objExtrusionMesh.position.copy(importedObjMesh.position);
                        objExtrusionMesh.rotation.copy(importedObjMesh.rotation);
                        meshData.push({ 
                            mesh: objExtrusionMesh, 
                            sunDirection: sunDirForExtrusion, 
                            extrusionIndex: i,
                            colorIndex: colorIndex,
                            dayOfYear: null,
                            timeProgress: null
                        });
                    }
                } else {
                    skippedCount++;
                }
            }
        }
        
        // Throttle console logging during animation
        const logTime = Date.now();
        if (shouldLog && logTime - lastLogTime > LOG_THROTTLE_MS) {
            console.timeEnd('Mesh Generation');
            console.log(`Generated ${meshData.length} meshes in ${CONFIG.showAllMonths ? `all year mode (every ${CONFIG.dayInterval} days, ${CONFIG.hourIntervalMinutes}min intervals, ${CONFIG.offsetMinutes}min offset)` : 'single week'} mode.`);
            if (skippedCount > 0) {
                console.log(`Skipped ${skippedCount} extrusions because the sun was below the horizon.`);
            }
            lastLogTime = logTime;
        }
        
        // Dispose old multipass if it exists
        if (multipass) {
            multipass.dispose();
        }
        
        // Create new multipass and process meshes
        const baseMeshes = [];
        if (CONFIG.showDummyMesh) baseMeshes.push(dummyMesh);
        if (CONFIG.showImportedMesh) baseMeshes.push(importedObjMesh);
        multipass = setupMultipassRendering(scene, camera, renderer, meshData, baseMeshes);
        multipass.processExistingMeshes(meshData);
    }

    // Initial generation
    generateExtrusions();

    // Create GUI (commented out for animation)
    // const gui = new GUI();
    // 
    // const guiParams = {
    //     week: CONFIG.week,
    //     showAllMonths: CONFIG.showAllMonths,
    //     showDummyMesh: CONFIG.showDummyMesh,
    //     showImportedMesh: CONFIG.showImportedMesh
    // };

    // gui.add(guiParams, 'week', 1, 52, 1).name('Week of Year').onChange((value) => {
    //     CONFIG.week = value;
    //     console.log(`Changed week to: ${value}`);
    //     if (!CONFIG.showAllMonths) {
    //         generateExtrusions();
    //     }
    // });

    // gui.add(guiParams, 'showAllMonths').name('Show All Year').onChange((value) => {
    //     CONFIG.showAllMonths = value;
    //     console.log(`Show all year: ${value}`);
    //     generateExtrusions();
    // });

    // gui.add(guiParams, 'showDummyMesh').name('Show Dummy Mesh').onChange((value) => {
    //     CONFIG.showDummyMesh = value;
    //     console.log(`Show dummy mesh: ${value}`);
    //     // Update scene visibility
    //     if (value) {
    //         scene.add(dummyMesh);
    //     } else {
    //         scene.remove(dummyMesh);
    //     }
    //     generateExtrusions();
    // });

    // gui.add(guiParams, 'showImportedMesh').name('Show Imported Mesh').onChange((value) => {
    //     CONFIG.showImportedMesh = value;
    //     console.log(`Show imported mesh: ${value}`);
    //     // Update scene visibility
    //     if (value) {
    //         scene.add(importedObjMesh);
    //     } else {
    //         scene.remove(importedObjMesh);
    //     }
    //     generateExtrusions();
    // });

    // Animation variables for sine wave oscillation
    let frameCount = 0;
    
    // Set initial configuration for animation
    CONFIG.showAllMonths = false; // Use single day mode for animation

    // Main render loop with optional sine wave animation
    const renderLoop = () => {
        requestAnimationFrame(renderLoop);
        
        // Animate day using sine wave oscillation (if enabled)
        if (CONFIG.animateDay) {
            frameCount += 1 / CONFIG.animationSpeed; // Higher animationSpeed = slower animation
            
            // Calculate new day based on sine wave (oscillates between day 1 and 365)
            const sineValue = Math.sin(frameCount * Math.PI / 182.5); // Complete cycle every 365 days
            const newDay = Math.round(183 + 182 * sineValue); // Maps sine (-1 to 1) to days (1 to 365, centered around 183)
            
            // Only regenerate if day changed significantly (avoid constant regeneration)
            if (Math.abs(CONFIG.day - newDay) >= 1) {
                CONFIG.day = newDay;
                generateExtrusions();
            }
        }
        
        if (stats) stats.update();
        multipass.render();
        controls.update();
    };

    // Handle window resize
    window.addEventListener('resize', () => {
        const isTouch = (
            ('ontouchstart' in window || navigator.maxTouchPoints > 0) &&
            /Mobi|Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
        );
        let width = window.innerWidth;
        let height = window.innerHeight;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        if (isTouch) {
            renderer.setSize(width / 2, height / 2, false);
            renderer.domElement.style.width = width + 'px';
            renderer.domElement.style.height = height + 'px';
        } else {
            renderer.setSize(width, height);
            renderer.domElement.style.width = '';
            renderer.domElement.style.height = '';
        }
        multipass.resize();
    });

    renderLoop();
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