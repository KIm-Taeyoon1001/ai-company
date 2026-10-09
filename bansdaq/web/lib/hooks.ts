"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged, User } from "firebase/auth";
import { doc, onSnapshot, Query, DocumentData } from "firebase/firestore";
import { fb } from "./firebase";
import type { ClassDoc, UserDoc } from "./types";

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => onAuthStateChanged(fb().auth, (u) => { setUser(u); setReady(true); }), []);
  return { user, ready };
}

// 구독 결과에 어떤 경로의 결과인지 함께 저장한다.
// 경로가 바뀐 직후 한 프레임 동안 "로딩 끝 + 데이터 없음" 으로 보이는 문제를 막는다.
export function useDocData<T>(path: string | null) {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: string | null }>({ path: null, data: null, error: null });
  useEffect(() => {
    if (!path) return;
    return onSnapshot(
      doc(fb().db, path),
      (s) => setState({ path, data: s.exists() ? ({ id: s.id, ...s.data() } as T) : null, error: null }),
      (e) => setState({ path, data: null, error: e.message }),
    );
  }, [path]);
  const fresh = state.path === path;
  return { data: fresh ? state.data : null, loading: path !== null && !fresh, error: fresh ? state.error : null };
}

/**
 * key 가 바뀔 때만 다시 구독한다. key 가 null 이면 구독하지 않는다.
 * 쿼리는 effect 안에서 만든다 → 서버 렌더링 중엔 Firebase 를 건드리지 않는다.
 */
export function useQueryData<T>(make: () => Query<DocumentData>, key: string | null) {
  const [state, setState] = useState<{ key: string | null; rows: (T & { id: string })[]; error: string | null }>({ key: null, rows: [], error: null });
  useEffect(() => {
    if (!key) return;
    return onSnapshot(
      make(),
      (s) => setState({ key, rows: s.docs.map((d) => ({ id: d.id, ...(d.data() as T) })), error: null }),
      (e) => setState({ key, rows: [], error: e.message }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const fresh = state.key === key;
  return { rows: fresh ? state.rows : [], loading: key !== null && !fresh, error: fresh ? state.error : null };
}

/** 로그인 사용자 + 내 users 문서 */
export function useMe() {
  const { user, ready } = useAuth();
  const { data: me, loading } = useDocData<UserDoc>(user ? `users/${user.uid}` : null);
  return { user, me, ready: ready && !loading };
}

export function useClass(id: string | null) {
  return useDocData<ClassDoc>(id ? `classes/${id}` : null);
}

/** 주기적으로 갱신되는 현재 시각 (장 운영 표시용) */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
