export const highlightVertexShader = `
    void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const highlightFragmentShader = `
    void main() {
        gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); // Pure red
    }
`;

export const extrusionVertexShader = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const extrusionFragmentShader = `
    uniform sampler2D tDiffuse;
    uniform float opacity;
    uniform vec3 extrusionColor;
    varying vec2 vUv;
    
    void main() {
        vec4 texel = texture2D(tDiffuse, vUv);
        // Only show colored pixels from the extrusion render
        if (texel.r > 0.9 && texel.g < 0.1 && texel.b < 0.1) { // Check for red mask
            gl_FragColor = vec4(extrusionColor, opacity);
        } else {
            // Discard transparent fragments to ensure proper blending
            discard; 
            // gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0); // Alternative: output transparent black
        }
    }
`;