// MediaPipe engines: PoseLandmarker (lite) every frame, FaceLandmarker every 3rd frame.
import { FilesetResolver, PoseLandmarker, FaceLandmarker } from "../vendor/vision_bundle.mjs";

let pose = null, face = null;

export async function initEngines() {
  const fileset = await FilesetResolver.forVisionTasks("vendor/wasm");
  pose = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "vendor/pose_landmarker_lite.task", delegate: "CPU" },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  face = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "vendor/face_landmarker.task", delegate: "CPU" },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  return true;
}

export function enginesReady() { return !!(pose && face); }

export function detectPose(video, ts) {
  if (!pose) return { lm: null, ms: 0 };
  const t0 = performance.now();
  const res = pose.detectForVideo(video, ts);
  const ms = performance.now() - t0;
  return { lm: res.landmarks && res.landmarks[0] ? res.landmarks[0] : null, ms };
}

export function detectFace(video, ts) {
  if (!face) return { blend: null, ms: 0 };
  const t0 = performance.now();
  const res = face.detectForVideo(video, ts);
  const ms = performance.now() - t0;
  let blend = null;
  if (res.faceBlendshapes && res.faceBlendshapes[0]) {
    blend = {};
    for (const c of res.faceBlendshapes[0].categories) blend[c.categoryName] = c.score;
  }
  return { blend, ms };
}