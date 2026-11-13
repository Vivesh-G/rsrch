import { useEffect, useState } from 'react';
import { readStoredJson, writeStoredJson } from '../utils/storage';

/**
 * React state backed by localStorage with debounced JSON writes so 60fps
 * UI updates (like sidebar dragging) batch into a single write.
 */
export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => readStoredJson(key, initial));

  useEffect(() => {
    const t = setTimeout(() => writeStoredJson(key, value), 250);
    return () => clearTimeout(t);
  }, [key, value]);

  return [value, setValue] as const;
}

