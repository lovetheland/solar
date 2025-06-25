import * as THREE from 'three';

// The vertex shader that performs the extrusion on the GPU.
const extrusionVertexShaderGPU = `
    precision highp float;

    attribute vec3 edgeVertexA;
    attribute vec3 edgeVertexB;
    attribute vec3 faceNormalA;
    attribute vec3 faceNormalB;
    attribute float quadVertexID;

    uniform vec3 sunDirection;
    uniform float extrusionDistance;

    void main() {
        // Use mediump for normals and dot products as full precision may not be necessary.
        mediump vec3 worldNormalA = normalize( (modelMatrix * vec4(faceNormalA, 0.0)).xyz );
        mediump vec3 worldNormalB = normalize( (modelMatrix * vec4(faceNormalB, 0.0)).xyz );

        // sunDirection is already in world space.
        mediump float dotA = dot(worldNormalA, sunDirection);
        mediump float dotB = dot(worldNormalB, sunDirection);

        // An edge is a silhouette edge if one face is lit and the other is not.
        float isSilhouette = step(0.0, dotA) * (1.0 - step(0.001, dotB)) + step(0.0, dotB) * (1.0 - step(0.001, dotA));

        // Position calculations must remain highp to avoid artifacts.
        vec3 finalPos_world;
        vec3 extrusionVector = -sunDirection * extrusionDistance;

        // This is a vertex of a side wall quad.
        if (isSilhouette > 0.5) {
            vec3 worldPosA = (modelMatrix * vec4(edgeVertexA, 1.0)).xyz;
            vec3 worldPosB = (modelMatrix * vec4(edgeVertexB, 1.0)).xyz;

            // Build the quad for the extruded side wall.
            if (quadVertexID < 0.5) finalPos_world = worldPosA;
            else if (quadVertexID < 1.5) finalPos_world = worldPosB;
            else if (quadVertexID < 2.5) finalPos_world = worldPosA + extrusionVector;
            else finalPos_world = worldPosB + extrusionVector;
        } else {
            // Not a silhouette edge, collapse the quad.
            vec3 worldPosA = (modelMatrix * vec4(edgeVertexA, 1.0)).xyz;
            finalPos_world = worldPosA;
        }

        gl_Position = projectionMatrix * viewMatrix * vec4(finalPos_world, 1.0);
    }
`;

// The fragment shader remains the same, just outputting red for the mask.
const extrusionFragmentShaderGPU = `
    precision mediump float;

    void main() {
        gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); // Pure red
    }
`;

export class GPUExtruder {
    constructor(baseGeometry) {
        this.preparedGeometry = this._prepareGeometry(baseGeometry);
    }

    // Creates a renderable mesh with the GPU extrusion material
    createMesh(sunDirection, distance) {
        const material = new THREE.ShaderMaterial({
            uniforms: {
                sunDirection: { value: sunDirection },
                extrusionDistance: { value: distance },
            },
            vertexShader: extrusionVertexShaderGPU,
            fragmentShader: extrusionFragmentShaderGPU,
            side: THREE.DoubleSide
        });

        const mesh = new THREE.Mesh(this.preparedGeometry, material);
        mesh.frustumCulled = false;
        return mesh;
    }

    _prepareGeometry(geometry) {
        // We need a non-indexed geometry to easily access face data.
        if (geometry.index) {
            geometry = geometry.toNonIndexed();
        }

        const sourcePositions = geometry.getAttribute('position');
        let sourceNormals = geometry.getAttribute('normal');

        // Ensure normals are present. If not, compute them.
        if (!sourceNormals) {
            geometry.computeVertexNormals();
            sourceNormals = geometry.getAttribute('normal');
        }

        const numVertices = sourcePositions.count;
        const numFaces = numVertices / 3;

        const edgeMap = new Map();
        const precision = 1e-4; // For hashing float positions

        // Creates a string key for a vertex position
        const getVertexKey = (v) => {
            return `${Math.round(v.x / precision)},${Math.round(v.y / precision)},${Math.round(v.z / precision)}`;
        };
        
        // Creates a canonical key for an edge from two vertex position keys
        const getEdgeKey = (keyA, keyB) => {
            return keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
        };

        // Step 1: Populate edgeMap with unique edges and their adjacent face normals.
        for (let i = 0; i < numFaces; i++) {
            const vIndices = [i * 3, i * 3 + 1, i * 3 + 2];
            const faceNormal = new THREE.Vector3().fromBufferAttribute(sourceNormals, vIndices[0]);

            for (let j = 0; j < 3; j++) {
                const vA_idx = vIndices[j];
                const vB_idx = vIndices[(j + 1) % 3];
                const vA = new THREE.Vector3().fromBufferAttribute(sourcePositions, vA_idx);
                const vB = new THREE.Vector3().fromBufferAttribute(sourcePositions, vB_idx);
                
                const key = getEdgeKey(getVertexKey(vA), getVertexKey(vB));

                if (!edgeMap.has(key)) {
                    edgeMap.set(key, {
                        vA: vA,
                        vB: vB,
                        normals: []
                    });
                }
                edgeMap.get(key).normals.push(faceNormal);
            }
        }

        const sideVerticesData = [];

        // Step 2: Create side quad data for edges with two adjacent faces.
        edgeMap.forEach(edge => {
            if (edge.normals.length === 2) {
                const { vA, vB, normals } = edge;
                const [normalA, normalB] = normals;
                
                const quadVertexIDs = [0, 1, 2, 1, 3, 2]; // A, B, A', B, B', A'
                for (const id of quadVertexIDs) {
                    sideVerticesData.push({ vA, vB, normalA, normalB, quadID: id });
                }
            }
        });

        const numSideVertices = sideVerticesData.length;
        const totalVertices = numSideVertices;

        // Step 3: Create and populate the BufferAttributes for the new geometry.
        const posAttr = new Float32Array(totalVertices * 3);
        const edgeAAttr = new Float32Array(totalVertices * 3);
        const edgeBAttr = new Float32Array(totalVertices * 3);
        const normalAAttr = new Float32Array(totalVertices * 3);
        const normalBAttr = new Float32Array(totalVertices * 3);
        const quadIDAttr = new Float32Array(totalVertices);

        // Fill attributes for the side vertices (the extruded walls).
        for (let i = 0; i < numSideVertices; i++) {
            const data = sideVerticesData[i];
            data.vA.toArray(edgeAAttr, i * 3);
            data.vB.toArray(edgeBAttr, i * 3);
            data.normalA.toArray(normalAAttr, i * 3);
            data.normalB.toArray(normalBAttr, i * 3);
            quadIDAttr[i] = data.quadID;
        }

        const preparedGeometry = new THREE.BufferGeometry();
        preparedGeometry.setAttribute('position', new THREE.BufferAttribute(posAttr, 3));
        preparedGeometry.setAttribute('edgeVertexA', new THREE.BufferAttribute(edgeAAttr, 3));
        preparedGeometry.setAttribute('edgeVertexB', new THREE.BufferAttribute(edgeBAttr, 3));
        preparedGeometry.setAttribute('faceNormalA', new THREE.BufferAttribute(normalAAttr, 3));
        preparedGeometry.setAttribute('faceNormalB', new THREE.BufferAttribute(normalBAttr, 3));
        preparedGeometry.setAttribute('quadVertexID', new THREE.BufferAttribute(quadIDAttr, 1));

        return preparedGeometry;
    }
}