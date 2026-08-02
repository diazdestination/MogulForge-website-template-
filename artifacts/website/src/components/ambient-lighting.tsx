import { useEffect, useRef } from 'react';
import { animate, motion, useReducedMotion } from 'framer-motion';

/**
 * Full-viewport ambient lighting layer.
 *
 * - Three large blurred radial orbs pulse gently on staggered 7–11 s loops,
 *   creating a soft, breathing glow against the dark background.
 * - A diagonal light streak sweeps across the viewport every 10 s, taking
 *   ~0.85 s to cross, giving a calm "lighting flash" moment.
 * - Hidden entirely when the user prefers reduced motion.
 * - aria-hidden + pointer-events-none: zero impact on interactive content.
 */
export function AmbientLighting() {
  const shouldReduce = useReducedMotion();
  const streakRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (shouldReduce) return;

    const run = () => {
      const el = streakRef.current;
      if (!el) return;
      void animate(
        el,
        { x: ['-180%', '210%'], opacity: [0, 0.28, 0.28, 0] },
        { duration: 0.85, ease: [0.22, 1, 0.36, 1] },
      );
    };

    // First streak fires ~2 s after mount so the page has settled.
    const initial = setTimeout(run, 2000);
    const interval = setInterval(run, 10000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [shouldReduce]);

  if (shouldReduce) return null;

  return (
    <div
      aria-hidden
      className="fixed inset-0 z-0 pointer-events-none overflow-hidden"
    >
      {/* Orb 1 — top-centre, primary blue, dominant anchor */}
      <motion.div
        animate={{ opacity: [0.18, 0.40, 0.18] }}
        transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut', delay: 0 }}
        className="absolute -top-[15%] left-1/2 -translate-x-1/2 w-[900px] h-[650px] rounded-full bg-primary/25 blur-[130px]"
      />

      {/* Orb 2 — upper-left, accent colour, secondary warmth */}
      <motion.div
        animate={{ opacity: [0.08, 0.20, 0.08] }}
        transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut', delay: 2.5 }}
        className="absolute top-[15%] -left-[12%] w-[700px] h-[500px] rounded-full bg-accent/20 blur-[110px]"
      />

      {/* Orb 3 — lower-right, soft blue depth fill */}
      <motion.div
        animate={{ opacity: [0.05, 0.16, 0.05] }}
        transition={{ duration: 11, repeat: Infinity, ease: 'easeInOut', delay: 5 }}
        className="absolute bottom-[5%] -right-[8%] w-[600px] h-[420px] rounded-full bg-primary/18 blur-[120px]"
      />

      {/* Diagonal light streak — sweeps left→right every 10 s */}
      <div
        ref={streakRef}
        style={{ opacity: 0 }}
        className="absolute top-[-40%] left-0 h-[180%] w-[280px] -rotate-[18deg] origin-top
                   bg-gradient-to-b from-transparent via-primary/45 to-transparent blur-[32px]"
      />
    </div>
  );
}
