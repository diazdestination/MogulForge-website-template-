export interface Review {
  quote: string;
  who: string;
  source: 'google';
  rating: 5;
}

export const GOOGLE_REVIEWS: Review[] = [
  {
    quote: 'They found the actual source of a leak two other companies had "fixed." Explained everything with photos before touching a single shingle. Worth every penny.',
    who: 'Sarah M. · Canton, GA',
    source: 'google',
    rating: 5,
  },
  {
    quote: 'Called at 11 pm with water coming through my ceiling during a storm. Real person answered, crew had a tarp up before morning, and the full repair was done by end of week.',
    who: 'James R. · Cumming, GA',
    source: 'google',
    rating: 5,
  },
  {
    quote: 'After hail hit our neighborhood every contractor in Cherokee County showed up door-knocking. Painless was the only one who said our roof might be fine without being paid first.',
    who: 'Lisa T. · Canton, GA',
    source: 'google',
    rating: 5,
  },
  {
    quote: 'New roof done in a day and a half. They walked the whole yard with a magnet for nails before leaving. You can tell it is family-run — they actually care about the finished product.',
    who: 'Marcus W. · Alpharetta, GA',
    source: 'google',
    rating: 5,
  },
  {
    quote: 'Walked us through the insurance process step by step, met the adjuster on site, and documented everything properly. No pressure, no inflated damage claims. Refreshingly honest.',
    who: 'David K. · Gainesville, GA',
    source: 'google',
    rating: 5,
  },
  {
    quote: 'Tree came through our garage roof in a storm. They had it tarped same night, rebuilt the decking and reshingled within a week. Communication was perfect the entire time.',
    who: 'Tanya B. · Dawsonville, GA',
    source: 'google',
    rating: 5,
  },
];
