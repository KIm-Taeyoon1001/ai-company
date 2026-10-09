import { initializeApp, getApps, FirebaseApp } from "firebase/app";
import { getAuth, connectAuthEmulator, Auth } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, Firestore } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable, Functions } from "firebase/functions";

// 서버 렌더링 중에 초기화하지 않도록 처음 쓰일 때 만든다.
let cache: { app: FirebaseApp; auth: Auth; db: Firestore; fns: Functions } | null = null;

export function fb() {
  if (cache) return cache;
  const app = getApps()[0] ?? initializeApp({
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  });
  const auth = getAuth(app);
  const db = getFirestore(app);
  const fns = getFunctions(app, "asia-northeast3");
  if (process.env.NEXT_PUBLIC_USE_EMULATOR === "1") {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    connectFunctionsEmulator(fns, "127.0.0.1", 5001);
  }
  cache = { app, auth, db, fns };
  return cache;
}

export async function call<R = unknown>(name: string, data: Record<string, unknown> = {}): Promise<R> {
  const res = await httpsCallable<Record<string, unknown>, R>(fb().fns, name)(data);
  return res.data;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "알 수 없는 오류가 발생했습니다.";
}
