import { useState } from 'react';
import { BUSINESS } from '@/lib/business';

/**
 * An "empty review slot" that mirrors Google's star-rating prompt.
 * Stars fill gold left-to-right as the cursor moves across them.
 * Clicking any star opens the Google review page.
 */
export function GoogleReviewCta() {
  const [hovered, setHovered] = useState(0);
  const [pressed, setPressed] = useState(false);

  return (
    <a
      href={BUSINESS.googleReviewUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Leave us a review on Google"
      onMouseLeave={() => setHovered(0)}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      className={`
        group flex flex-col p-7 rounded-3xl border border-dashed transition-all duration-300 cursor-pointer select-none
        ${hovered > 0
          ? 'bg-card/60 border-yellow-400/50 shadow-[0_0_24px_rgba(251,191,36,0.12)]'
          : 'bg-card/20 border-card-border hover:border-white/20'}
        ${pressed ? 'scale-[0.98]' : 'scale-100'}
        focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2
      `}
    >
      {/* Google G + label */}
      <div className="flex items-center gap-2.5 mb-5">
        <svg aria-hidden viewBox="0 0 24 24" className="w-5 h-5 shrink-0" fill="none">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        <span className="text-sm font-medium text-muted-foreground group-hover:text-white/70 transition-colors">
          Leave a Google review
        </span>
      </div>

      {/* Interactive stars */}
      <div className="flex gap-1.5 mb-5" role="img" aria-label="Rate us 1 to 5 stars">
        {[1, 2, 3, 4, 5].map((n) => (
          <span
            key={n}
            onMouseEnter={() => setHovered(n)}
            className="text-3xl leading-none transition-all duration-100"
            style={{
              color: n <= hovered ? '#FBBF24' : 'transparent',
              WebkitTextStroke: n <= hovered ? '0px' : '1.5px rgba(255,255,255,0.2)',
              transform: n <= hovered ? 'scale(1.2)' : 'scale(1)',
              display: 'inline-block',
            }}
            aria-hidden
          >
            ★
          </span>
        ))}
      </div>

      {/* Prompt text */}
      <p className="text-base font-semibold text-white/80 group-hover:text-white transition-colors flex-1">
        {hovered === 0
          ? 'Had a good experience?'
          : hovered < 4
          ? 'We\'d love to hear from you.'
          : 'We appreciate it — thank you!'}
      </p>
      <p className="mt-1.5 text-sm text-muted-foreground">
        {hovered === 0
          ? 'Tap a star to share your experience on Google.'
          : 'Click to open Google and write your review.'}
      </p>
    </a>
  );
}
