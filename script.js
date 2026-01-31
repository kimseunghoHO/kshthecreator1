import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// --- Configuration ---
const CHARS = "KSHTC LOM".split("").filter(c => c.trim() !== ""); // "K", "S", "H", "T", "C", "L", "O", "M"
const BEAM_COLORS = [
    new THREE.Color('#FF0000'),
    new THREE.Color('#FFFFFF'),
    new THREE.Color('#0100FF')
];
const CYCLE_DURATION = 2.0; // Reduced duration to 2.0s

// --- Scene Setup ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.z = 100; // Initial

const renderer = new THREE.WebGLRenderer({ antialias: false }); // Antialias off for post-processing
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ReinhardToneMapping;
document.body.appendChild(renderer.domElement);

// --- Post-Processing ---
const renderScene = new RenderPass(scene, camera);

// Bloom for "Glow" and "Blur" effect
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
bloomPass.threshold = 0.1;
bloomPass.strength = 0.5; // Slightly increased for atmosphere
bloomPass.radius = 1.8; // Maximize spread for background glow feel

const composer = new EffectComposer(renderer);
composer.addPass(renderScene);
composer.addPass(bloomPass);

// --- Resize Handler ---
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
});

// --- Shader ---
// Opaque material, Black base, Colored Light Scanning Beam
const vertexShader = `
    varying vec3 vViewPosition;
    varying vec3 vNormal;
    varying vec3 vPosition;

    void main() {
        vPosition = position;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = -mvPosition.xyz;
        vNormal = normalMatrix * normal;
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const fragmentShader = `
    uniform vec3 uBeamColor;
    uniform float uScanY;
    uniform float uClickFlash; // 0.0 to 1.0+
    
    varying vec3 vPosition;
    varying vec3 vNormal;
    varying vec3 vViewPosition;

    void main() {
        vec3 normal = normalize(vNormal);
        vec3 viewDir = normalize(vViewPosition);
        
        // 1. Scanning Beam Logic
        // Beam moves Top to Bottom.
        float dist = vPosition.y - uScanY;
        
        // Beam Shape:
        // Core beam (brightest) + Trail (fading up)
        // scanY moves down. vPosition.y > uScanY is "behind" the beam (above it).
        // Beams leaves a trail behind it (dist > 0).
        // User wanted wider area and longer persistence.
        
        float spreadTop = 180.0; // Much Wider Trail
        float spreadBottom = 100.0; // Wider Lead
        
        float spread = (dist > 0.0) ? spreadTop : spreadBottom;
        
        float beamIntensity = 1.0 - smoothstep(0.0, spread, abs(dist));
        beamIntensity = pow(beamIntensity, 2.0); // Sharper peak
        beamIntensity *= 0.6; // Reduced brightness as requested

        // 2. Rim / Edge Persistence
        // "Edges hold light longer"
        // Standard Fresnel/Rim
        float NdotV = dot(normal, viewDir);
        float rim = 1.0 - max(0.0, NdotV);
        rim = pow(rim, 2.0); // Broad rim
        
        // Edge Glow should be visible even if beam is slightly far?
        // Let's modify beamIntensity for edges.
        // If rim is high, effectively widen the spread or boost intensity.
        float edgeBoost = rim * 0.8; 
        
        // Combined Light Map
        float totalLight = beamIntensity + (beamIntensity * edgeBoost * 2.0);
        
        // "Natural disappearance" -> If beam is far, totalLight goes to 0.
        
        // 3. Click Flash
        // Multiplicative Flash: Only brightens existing light, keeping dark areas dark.
        totalLight *= (1.0 + uClickFlash);

        // Base Color is Black (User Said: "No color, Opaque"). 
        // Light reveals the "uBeamColor".
        vec3 finalColor = uBeamColor * totalLight;

        gl_FragColor = vec4(finalColor, 1.0); // Opaque
    }
`;

const customMaterial = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
        uBeamColor: { value: new THREE.Color(0xffffff) },
        uScanY: { value: 0.0 },
        uClickFlash: { value: 0.0 }
    },
    transparent: false,
    side: THREE.DoubleSide
});

// --- State ---
let charIndex = 0;
let currentMesh = null;
let meshStartTime = 0;
let currentFont = null;

// Geometry Bounds for Animation
let geoTopY = 0;
let geoBottomY = 0;

// Interaction Physics
let isDragging = false;
let previousMouse = { x: 0, y: 0 };
let rotationVelocity = { x: 0, y: 0 };
// Initial Random Rotation state
let currentRotation = {
    x: (Math.random() - 0.5) * Math.PI * 2,
    y: (Math.random() - 0.5) * Math.PI * 2,
    z: (Math.random() - 0.5) * Math.PI * 2
};
const friction = 0.99; // Increased inertia (slower damping)
let targetScale = 1.0;
let currentScale = 1.0;
let clickFlashValue = 0.0;

// --- Logic ---

function createLetter() {
    if (!currentFont) return;
    if (currentMesh) {
        // Save continuous rotation from previous mesh
        currentRotation.x = currentMesh.rotation.x;
        currentRotation.y = currentMesh.rotation.y;
        currentRotation.z = currentMesh.rotation.z;

        scene.remove(currentMesh);
        currentMesh.geometry.dispose();
    }

    const char = CHARS[charIndex];
    // Random Beam Color
    const beamColor = BEAM_COLORS[Math.floor(Math.random() * BEAM_COLORS.length)];

    // "Thick and Flattened"
    // Thickness = height parameters
    // Flattened = scale Y ?
    const geometry = new TextGeometry(char, {
        font: currentFont,
        size: 50,
        height: 35, // Very thick
        curveSegments: 60, // Ultra High poly
        bevelEnabled: true,
        bevelThickness: 6, // Stronger bevel
        bevelSize: 1.5, // Reduced width to avoid artifact overlaps
        bevelOffset: 0,
        bevelSegments: 12 // Ultra Smooth bevel
    });

    // Smooth out the faceting
    geometry.computeVertexNormals();

    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const sizeX = box.max.x - box.min.x;
    const sizeY = box.max.y - box.min.y;
    const sizeZ = box.max.z - box.min.z;

    geoTopY = box.max.y;
    geoBottomY = box.min.y;

    // Center
    // Correct centering: Translate by negative of BoundingBox center
    const centerOffsetX = -0.5 * (box.max.x + box.min.x);
    const centerOffsetY = -0.5 * (box.max.y + box.min.y);
    const centerOffsetZ = -0.5 * (box.max.z + box.min.z);

    geometry.translate(centerOffsetX, centerOffsetY, centerOffsetZ);

    // Update Bounds after translate (roughly +/- half size)
    // Recalculate box to be sure
    geometry.computeBoundingBox();
    geoTopY = geometry.boundingBox.max.y;
    geoBottomY = geometry.boundingBox.min.y;

    currentMesh = new THREE.Mesh(geometry, customMaterial);

    // Apply continuous rotation
    currentMesh.rotation.set(currentRotation.x, currentRotation.y, currentRotation.z);

    // Flatten effect? "Flat and Thick"
    // Scale Y down slightly?
    currentMesh.scale.set(1.2, 0.8, 1.0); // Make it slightly wide/flat

    // Update Uniforms
    customMaterial.uniforms.uBeamColor.value.copy(beamColor);
    customMaterial.uniforms.uClickFlash.value = 0.0;

    scene.add(currentMesh);

    // Camera Fit
    // "Fill the display" - Reverted to original
    const fov = camera.fov * (Math.PI / 180);
    const targetH = sizeY * 0.9; // Fill most of screen (Original)
    const dist = targetH / (2 * Math.tan(fov / 2));
    camera.position.z = dist + 40; // Original offset
}

// --- Interaction Events ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

let downTime = 0;
let downPos = { x: 0, y: 0 };

function onDown(x, y) {
    isDragging = true;
    previousMouse.x = x;
    previousMouse.y = y;
    downPos.x = x;
    downPos.y = y;
    downTime = Date.now();

    rotationVelocity.x = 0;
    rotationVelocity.y = 0;
}

function onMove(x, y) {
    if (isDragging && currentMesh) {
        const deltaX = x - previousMouse.x;
        const deltaY = y - previousMouse.y;

        // "Follow cursor"
        rotationVelocity.y = deltaX * 0.01;
        rotationVelocity.x = deltaY * 0.01;

        currentMesh.rotation.y += rotationVelocity.y;
        currentMesh.rotation.x += rotationVelocity.x;

        previousMouse.x = x;
        previousMouse.y = y;
    }
}

function onUp(x, y) {
    isDragging = false;

    // Tap Detection
    // If held for less than 250ms and moved less than 5 pixels -> Tap
    const timeDelta = Date.now() - downTime;
    const dist = Math.sqrt(Math.pow(x - downPos.x, 2) + Math.pow(y - downPos.y, 2));

    if (timeDelta < 250 && dist < 5) {
        // Trigger "Boing" and Flash only on Tap
        currentScale = 1.1; // Reduced jump
        targetScale = 1.0;  // Return to normal
        clickFlashValue = 0.5; // Very subtle multiplier
    }
}

// Mouse
window.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY));
window.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
window.addEventListener('mouseup', (e) => onUp(e.clientX, e.clientY));

// Touch
window.addEventListener('touchstart', (e) => {
    if (e.touches.length > 0) onDown(e.touches[0].clientX, e.touches[0].clientY);
});
window.addEventListener('touchmove', (e) => {
    if (e.touches.length > 0) onMove(e.touches[0].clientX, e.touches[0].clientY);
});
// Touch end usually doesn't have clientX/Y in changedTouches same way, need careful handling.
// e.changedTouches[0] has coordinates.
window.addEventListener('touchend', (e) => {
    if (e.changedTouches.length > 0) {
        onUp(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    } else {
        onUp(previousMouse.x, previousMouse.y); // Fallback
    }
});


// --- Main Loop ---
const clock = new THREE.Clock();
const loader = new FontLoader();

loader.load('https://unpkg.com/three@0.160.0/examples/fonts/helvetiker_bold.typeface.json', (font) => {
    currentFont = font;
    createLetter();
    meshStartTime = clock.getElapsedTime();

    animate();
});

function animate() {
    requestAnimationFrame(animate);

    const now = clock.getElapsedTime();
    const delta = clock.getDelta(); // Careful, calling getDelta with getElapsedTime might be tricky if not managing clock well. 
    // Actually getElapsedTime() doesn't reset delta. getDelta() returns time since last getDelta call.
    // Ideally use one.

    // Re-calc time since this letter started
    const elapsed = now - meshStartTime;

    // 1. Cycle Logic
    if (elapsed > CYCLE_DURATION) {
        charIndex = (charIndex + 1) % CHARS.length;
        createLetter();
        meshStartTime = now;
    }

    if (currentMesh) {
        // 2. Scan Logic
        // 2 seconds duration
        const progress = elapsed / CYCLE_DURATION; // 0.0 to 1.0
        // Top to Bottom
        // Safe margin to fully clear
        // Trail is 180.0. Margin needs to be larger.
        const margin = 250.0;
        const startY = geoTopY + margin;
        const endY = geoBottomY - margin;

        const currentScanY = THREE.MathUtils.lerp(startY, endY, progress);
        customMaterial.uniforms.uScanY.value = currentScanY;

        // 3. Rotation Logic
        if (!isDragging) {
            // Inertia
            currentMesh.rotation.x += rotationVelocity.x;
            currentMesh.rotation.y += rotationVelocity.y;

            // Damping
            rotationVelocity.x *= friction;
            rotationVelocity.y *= friction;

            // "Slowly rotate" base movement if velocity is low
            if (Math.abs(rotationVelocity.x) < 0.001 && Math.abs(rotationVelocity.y) < 0.001) {
                // Random drift - Further reduced speed
                currentMesh.rotation.x += 0.0002;
                currentMesh.rotation.y += 0.0003;
                currentMesh.rotation.z += 0.0001;
            }
        }

        // 4. Click Effect Physics (Scale)
        // Spring-ish: Lerp to target
        currentScale = THREE.MathUtils.lerp(currentScale, targetScale, 0.1);
        currentMesh.scale.set(currentScale * 1.2, currentScale * 0.8, currentScale); // Maintain flattening aspect

        // Flash Decay
        clickFlashValue = THREE.MathUtils.lerp(clickFlashValue, 0.0, 0.05);
        customMaterial.uniforms.uClickFlash.value = clickFlashValue;
    }

    // Render
    composer.render();
}
