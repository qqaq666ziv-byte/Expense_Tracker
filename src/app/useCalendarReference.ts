import { useEffect, useState } from 'react';

export function millisecondsUntilNextLocalDay(reference: Date): number {
  const nextDay = new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(1, nextDay.getTime() - reference.getTime());
}

/** Refresh calendar-based views at local midnight and after returning to the app. */
export function useCalendarReference(): Date {
  const [reference, setReference] = useState(() => new Date());

  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      const now = new Date();
      setReference(now);
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(refresh, millisecondsUntilNextLocalDay(now) + 25);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };

    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, []);

  return reference;
}
