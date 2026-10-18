import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";

/** 简单的加载器：组件挂载/依赖变化时执行，返回 data/loading/error/reload。 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const run = useCallback(() => {
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => {
        if (seq.current === id) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (seq.current === id) {
          setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
  }, [run]);

  return { data, loading, error, reload: run, setData };
}

export function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
