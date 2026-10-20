"use client";

/**
 * Rara3D — procedural chibi 3D anime girl character built from Three.js
 * primitives. No external GLB model needed.
 *
 * Mood states drive the animation:
 *   - idle     → gentle vertical bob, slow head tilt, occasional blink
 *   - thinking → head tilts up, eyes look upward, finger-on-chin pose
 *   - talking  → mouth opens/closes cycle, slight body bounce
 *   - happy    → big smile, slight jump, eyes curve up
 *   - shy      → hands cover mouth, head looks down, blush visible
 *
 * The component reads the mood prop and animates accordingly via useFrame.
 *
 * The whole scene is wrapped in <Canvas> from @react-three/fiber.
 * Lights + camera are set up inside.
 */

import { Canvas, useFrame } from "@react-three/fiber";
import { Float, ContactShadows, OrbitControls } from "@react-three/drei";
import { useRef, useMemo, Suspense, useEffect } from "react";
import * as THREE from "three";

export type RaraMood = "idle" | "thinking" | "talking" | "happy" | "shy";

interface Rara3DProps {
  mood?: RaraMood;
  size?: number; // pixel size for the canvas (square)
  className?: string;
  /** Show the floating platform/disc shadow under the character */
  showPlatform?: boolean;
  /** Auto-rotate camera slowly (showcase mode) */
  autoRotate?: boolean;
}

// ── Color palette (ceria manis — soft pinks + cream) ────────────────────────
const COLORS = {
  skin: "#FFE4D6",
  hair: "#FF9CC1",        // pink twin-tails
  hairShade: "#E6709A",
  dress: "#FF82A8",
  dressShade: "#D85C84",
  bow: "#FF4D8C",
  eye: "#2D1B3D",
  eyeHighlight: "#FFFFFF",
  blush: "#FFB5C5",
  mouth: "#C8395C",
  mouthHappy: "#FF6B95",
  shoe: "#5A2D3F",
};

// ── Head (with face features) ────────────────────────────────────────────────
function Head({ moodRef }: { moodRef: React.RefObject<RaraMood> }) {
  const headGroup = useRef<THREE.Group>(null);
  const leftEye = useRef<THREE.Mesh>(null);
  const rightEye = useRef<THREE.Mesh>(null);
  const mouth = useRef<THREE.Mesh>(null);
  const blushLeft = useRef<THREE.Mesh>(null);
  const blushRight = useRef<THREE.Mesh>(null);
  const hairL = useRef<THREE.Group>(null);
  const hairR = useRef<THREE.Group>(null);
  const bow = useRef<THREE.Group>(null);

  const blinkPhase = useRef(0);
  const nextBlinkAt = useRef(2 + Math.random() * 4);
  const talkPhase = useRef(0);

  useFrame((state, delta) => {
    if (!headGroup.current) return;
    const t = state.clock.elapsedTime;
    const mood = moodRef.current || "idle";

    // Gentle bob
    headGroup.current.position.y = Math.sin(t * 1.2) * 0.04;

    // Head tilt by mood
    const targetTiltX =
      mood === "thinking" ? -0.25 :
      mood === "shy" ? 0.30 :
      mood === "happy" ? -0.05 :
      Math.sin(t * 0.6) * 0.04; // idle gentle sway
    const targetTiltZ =
      mood === "thinking" ? 0.15 :
      mood === "shy" ? -0.20 :
      Math.sin(t * 0.5) * 0.05;
    headGroup.current.rotation.x += (targetTiltX - headGroup.current.rotation.x) * 0.1;
    headGroup.current.rotation.z += (targetTiltZ - headGroup.current.rotation.z) * 0.1;

    // Blink (idle, thinking, happy moods only)
    if (mood === "idle" || mood === "thinking" || mood === "happy") {
      blinkPhase.current += delta;
      if (blinkPhase.current > nextBlinkAt.current) {
        // start blink
        blinkPhase.current = 0;
        nextBlinkAt.current = 2 + Math.random() * 4;
      }
      const blinkTime = blinkPhase.current;
      // Blink lasts 0.15s, eyes scale Y to 0.1 and back
      let eyeScaleY = 1;
      if (blinkTime < 0.15) {
        const blinkProgress = blinkTime / 0.15;
        eyeScaleY = 1 - Math.sin(blinkProgress * Math.PI) * 0.9;
      }
      if (leftEye.current) leftEye.current.scale.y = eyeScaleY;
      if (rightEye.current) rightEye.current.scale.y = eyeScaleY;
    } else {
      if (leftEye.current) leftEye.current.scale.y = 1;
      if (rightEye.current) rightEye.current.scale.y = 1;
    }

    // Mouth shape by mood
    if (mouth.current) {
      if (mood === "talking") {
        talkPhase.current += delta * 8;
        const open = (Math.sin(talkPhase.current) * 0.5 + 0.5) * 0.6 + 0.1;
        mouth.current.scale.y = open;
        mouth.current.scale.x = 0.8;
        mouth.current.rotation.z = 0;
      } else if (mood === "happy") {
        mouth.current.scale.x = 1.2;
        mouth.current.scale.y = 0.3;
        mouth.current.rotation.z = Math.PI; // smile curve
      } else if (mood === "shy") {
        mouth.current.scale.x = 0.6;
        mouth.current.scale.y = 0.3;
        mouth.current.rotation.z = 0;
      } else if (mood === "thinking") {
        mouth.current.scale.x = 0.8;
        mouth.current.scale.y = 0.15;
        mouth.current.rotation.z = 0;
      } else {
        // idle — soft small smile
        mouth.current.scale.x = 0.9;
        mouth.current.scale.y = 0.25;
        mouth.current.rotation.z = Math.PI;
      }
    }

    // Blush intensity by mood
    const blushOpacity =
      mood === "shy" ? 1.0 :
      mood === "happy" ? 0.8 :
      mood === "thinking" ? 0.3 :
      0.4;
    [blushLeft, blushRight].forEach(ref => {
      if (ref.current) {
        const mat = ref.current.material as THREE.MeshStandardMaterial;
        mat.opacity = blushOpacity;
        mat.transparent = true;
      }
    });

    // Twin-tail hair sway
    const sway = Math.sin(t * 0.8) * 0.08;
    if (hairL.current) hairL.current.rotation.z = 0.3 + sway;
    if (hairR.current) hairR.current.rotation.z = -0.3 - sway;

    // Bow gentle bob
    if (bow.current) {
      bow.current.rotation.y = Math.sin(t * 0.7) * 0.15;
    }
  });

  return (
    <group ref={headGroup} position={[0, 0.55, 0]}>
      {/* Head sphere (slightly squished) */}
      <mesh scale={[1, 1.05, 1]} castShadow>
        <sphereGeometry args={[0.55, 32, 32]} />
        <meshStandardMaterial color={COLORS.skin} roughness={0.7} />
      </mesh>

      {/* Hair top (covers back of head) */}
      <mesh position={[0, 0.15, -0.05]} scale={[1.05, 0.9, 1.05]}>
        <sphereGeometry args={[0.58, 24, 24, 0, Math.PI * 2, 0, Math.PI * 0.55]} />
        <meshStandardMaterial color={COLORS.hair} roughness={0.6} />
      </mesh>

      {/* Bangs (front hair fringe) */}
      <mesh position={[0, 0.20, 0.45]} rotation={[0.2, 0, 0]} scale={[1.0, 0.4, 0.5]}>
        <sphereGeometry args={[0.55, 16, 16]} />
        <meshStandardMaterial color={COLORS.hair} roughness={0.65} />
      </mesh>

      {/* Twin-tail left (long cylinder) */}
      <group ref={hairL} position={[-0.50, 0.05, -0.05]}>
        <mesh position={[-0.10, -0.45, 0]} rotation={[0, 0, 0.3]} castShadow>
          <coneGeometry args={[0.16, 1.0, 12]} />
          <meshStandardMaterial color={COLORS.hair} roughness={0.6} />
        </mesh>
        {/* Tail tip (darker shade) */}
        <mesh position={[-0.15, -0.95, 0]} rotation={[0, 0, 0.3]}>
          <coneGeometry args={[0.10, 0.20, 12]} />
          <meshStandardMaterial color={COLORS.hairShade} roughness={0.6} />
        </mesh>
      </group>

      {/* Twin-tail right */}
      <group ref={hairR} position={[0.50, 0.05, -0.05]}>
        <mesh position={[0.10, -0.45, 0]} rotation={[0, 0, -0.3]} castShadow>
          <coneGeometry args={[0.16, 1.0, 12]} />
          <meshStandardMaterial color={COLORS.hair} roughness={0.6} />
        </mesh>
        <mesh position={[0.15, -0.95, 0]} rotation={[0, 0, -0.3]}>
          <coneGeometry args={[0.10, 0.20, 12]} />
          <meshStandardMaterial color={COLORS.hairShade} roughness={0.6} />
        </mesh>
      </group>

      {/* Bow on top */}
      <group ref={bow} position={[0, 0.40, 0.05]}>
        {/* Left bow wing */}
        <mesh rotation={[0, 0, 0.4]} position={[-0.10, 0, 0]}>
          <octahedronGeometry args={[0.10, 0]} />
          <meshStandardMaterial color={COLORS.bow} roughness={0.5} metalness={0.1} />
        </mesh>
        {/* Right bow wing */}
        <mesh rotation={[0, 0, -0.4]} position={[0.10, 0, 0]}>
          <octahedronGeometry args={[0.10, 0]} />
          <meshStandardMaterial color={COLORS.bow} roughness={0.5} metalness={0.1} />
        </mesh>
        {/* Bow knot */}
        <mesh>
          <sphereGeometry args={[0.05, 12, 12]} />
          <meshStandardMaterial color={COLORS.bow} roughness={0.5} />
        </mesh>
      </group>

      {/* Left eye (white + pupil) */}
      <group position={[-0.18, 0.0, 0.48]}>
        <mesh ref={leftEye}>
          <sphereGeometry args={[0.085, 16, 16]} />
          <meshStandardMaterial color={COLORS.eye} roughness={0.3} />
        </mesh>
        {/* Highlight (always-on) */}
        <mesh position={[0.04, 0.04, 0.04]}>
          <sphereGeometry args={[0.025, 8, 8]} />
          <meshStandardMaterial color={COLORS.eyeHighlight} emissive="#FFFFFF" emissiveIntensity={0.4} />
        </mesh>
      </group>

      {/* Right eye */}
      <group position={[0.18, 0.0, 0.48]}>
        <mesh ref={rightEye}>
          <sphereGeometry args={[0.085, 16, 16]} />
          <meshStandardMaterial color={COLORS.eye} roughness={0.3} />
        </mesh>
        <mesh position={[-0.04, 0.04, 0.04]}>
          <sphereGeometry args={[0.025, 8, 8]} />
          <meshStandardMaterial color={COLORS.eyeHighlight} emissive="#FFFFFF" emissiveIntensity={0.4} />
        </mesh>
      </group>

      {/* Blush left */}
      <mesh ref={blushLeft} position={[-0.28, -0.10, 0.42]}>
        <sphereGeometry args={[0.07, 12, 12]} />
        <meshStandardMaterial color={COLORS.blush} roughness={0.9} transparent opacity={0.5} />
      </mesh>
      {/* Blush right */}
      <mesh ref={blushRight} position={[0.28, -0.10, 0.42]}>
        <sphereGeometry args={[0.07, 12, 12]} />
        <meshStandardMaterial color={COLORS.blush} roughness={0.9} transparent opacity={0.5} />
      </mesh>

      {/* Mouth (small sphere half-visible) */}
      <mesh ref={mouth} position={[0, -0.18, 0.49]}>
        <sphereGeometry args={[0.07, 16, 16, 0, Math.PI * 2, 0, Math.PI]} />
        <meshStandardMaterial color={COLORS.mouth} roughness={0.4} />
      </mesh>
    </group>
  );
}

// ── Body (dress) + arms + legs ──────────────────────────────────────────────
function Body({ moodRef }: { moodRef: React.RefObject<RaraMood> }) {
  const bodyGroup = useRef<THREE.Group>(null);
  const leftHand = useRef<THREE.Group>(null);
  const rightHand = useRef<THREE.Group>(null);

  useFrame((state) => {
    if (!bodyGroup.current) return;
    const t = state.clock.elapsedTime;
    const mood = moodRef.current || "idle";

    // Body bob
    bodyGroup.current.position.y = Math.sin(t * 1.5) * 0.02;

    // Happy = bigger bounce
    if (mood === "happy") {
      bodyGroup.current.position.y = Math.abs(Math.sin(t * 3)) * 0.10;
    }

    // Shy = hands cover mouth (raise both hands to face level)
    if (mood === "shy") {
      if (leftHand.current) leftHand.current.position.set(0.28, 0.50, 0.30);
      if (rightHand.current) rightHand.current.position.set(-0.28, 0.50, 0.30);
    } else if (mood === "thinking") {
      // Right hand to chin
      if (rightHand.current) rightHand.current.position.set(-0.20, 0.50, 0.40);
      if (leftHand.current) leftHand.current.position.set(0.30, 0.10, 0.10);
    } else {
      // Idle arms relaxed
      if (leftHand.current) leftHand.current.position.set(0.30, 0.15, 0.10);
      if (rightHand.current) rightHand.current.position.set(-0.30, 0.15, 0.10);
    }
  });

  return (
    <group ref={bodyGroup} position={[0, -0.45, 0]}>
      {/* Dress (trapezoid cone) */}
      <mesh position={[0, -0.25, 0]} castShadow>
        <coneGeometry args={[0.45, 0.85, 16, 1, false]} />
        <meshStandardMaterial color={COLORS.dress} roughness={0.7} />
      </mesh>
      {/* Collar (lighter shade) */}
      <mesh position={[0, 0.18, 0]}>
        <torusGeometry args={[0.18, 0.04, 8, 24]} />
        <meshStandardMaterial color={COLORS.dressShade} roughness={0.7} />
      </mesh>

      {/* Left arm */}
      <group ref={leftHand} position={[0.30, 0.15, 0.10]}>
        <mesh rotation={[0, 0, -0.3]}>
          <capsuleGeometry args={[0.07, 0.30, 8, 16]} />
          <meshStandardMaterial color={COLORS.dress} roughness={0.7} />
        </mesh>
        {/* Hand */}
        <mesh position={[0.06, -0.20, 0]}>
          <sphereGeometry args={[0.09, 12, 12]} />
          <meshStandardMaterial color={COLORS.skin} roughness={0.7} />
        </mesh>
      </group>

      {/* Right arm */}
      <group ref={rightHand} position={[-0.30, 0.15, 0.10]}>
        <mesh rotation={[0, 0, 0.3]}>
          <capsuleGeometry args={[0.07, 0.30, 8, 16]} />
          <meshStandardMaterial color={COLORS.dress} roughness={0.7} />
        </mesh>
        <mesh position={[-0.06, -0.20, 0]}>
          <sphereGeometry args={[0.09, 12, 12]} />
          <meshStandardMaterial color={COLORS.skin} roughness={0.7} />
        </mesh>
      </group>

      {/* Legs (two short capsules) */}
      <mesh position={[-0.13, -0.75, 0]}>
        <capsuleGeometry args={[0.10, 0.20, 8, 16]} />
        <meshStandardMaterial color={COLORS.skin} roughness={0.7} />
      </mesh>
      <mesh position={[0.13, -0.75, 0]}>
        <capsuleGeometry args={[0.10, 0.20, 8, 16]} />
        <meshStandardMaterial color={COLORS.skin} roughness={0.7} />
      </mesh>
      {/* Shoes */}
      <mesh position={[-0.13, -0.92, 0.05]}>
        <boxGeometry args={[0.18, 0.10, 0.25]} />
        <meshStandardMaterial color={COLORS.shoe} roughness={0.5} />
      </mesh>
      <mesh position={[0.13, -0.92, 0.05]}>
        <boxGeometry args={[0.18, 0.10, 0.25]} />
        <meshStandardMaterial color={COLORS.shoe} roughness={0.5} />
      </mesh>
    </group>
  );
}

// ── Full character (head + body) with subtle floating ───────────────────────
function RaraCharacter({ moodRef }: { moodRef: React.RefObject<RaraMood> }) {
  return (
    <Float speed={1.5} rotationIntensity={0.15} floatIntensity={0.3}>
      <group position={[0, 0, 0]} scale={1}>
        <Head moodRef={moodRef} />
        <Body moodRef={moodRef} />
      </group>
    </Float>
  );
}

// ── Public API ───────────────────────────────────────────────────────────────
export function Rara3D({
  mood = "idle",
  size = 240,
  className,
  showPlatform = true,
  autoRotate = false,
}: Rara3DProps) {
  const moodRef = useRef<RaraMood>(mood);
  // Update the ref inside an effect so we never mutate it during render.
  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);

  const cameraPos: [number, number, number] = useMemo(() => [0, 0.2, 3.4], []);

  return (
    <div className={className} style={{ width: size, height: size, pointerEvents: "none" }}>
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ position: cameraPos, fov: 38 }}
        style={{ background: "transparent" }}
        gl={{ alpha: true, antialias: true }}
      >
        <Suspense fallback={null}>
          {/* Lights */}
          <ambientLight intensity={0.7} />
          <directionalLight
            position={[3, 5, 2]}
            intensity={1.5}
            castShadow
            shadow-mapSize-width={1024}
            shadow-mapSize-height={1024}
          />
          <pointLight position={[-3, -1, 2]} intensity={0.4} color="#FFB7C5" />

          <RaraCharacter moodRef={moodRef} />

          {showPlatform && (
            <ContactShadows
              position={[0, -1.45, 0]}
              opacity={0.35}
              scale={4}
              blur={2.5}
              far={3}
              color="#FF9CC1"
            />
          )}

          {/* HDR env map removed (network fetch fails in dev). Standard lights are enough. */}
          {autoRotate && (
            <OrbitControls
              autoRotate
              autoRotateSpeed={1.5}
              enableZoom={false}
              enablePan={false}
              enableRotate={false}
            />
          )}
        </Suspense>
      </Canvas>
    </div>
  );
}

export default Rara3D;
