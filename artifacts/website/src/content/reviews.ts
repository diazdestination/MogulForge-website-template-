export interface Review {
  quote: string;
  who: string;
  source: 'google';
  rating: 5;
}

export const GOOGLE_REVIEWS: Review[] = [
  {
    quote: 'They found the actual source of a leak two other companies had "fixed." Explained everything with photos before touching anything.',
    who: 'Homeowner, Canton',
    source: 'google',
    rating: 5,
  },
  {
    quote: 'Called at 11 pm during a storm with water coming through the ceiling. A real person answered and they had it tarped before morning.',
    who: 'Homeowner, Cumming',
    source: 'google',
    rating: 5,
  },
  {
    quote: 'Walked us through the insurance process without any of the pressure tactics we got from the storm chasers. Straight answers the whole way.',
    who: 'Homeowner, Gainesville',
    source: 'google',
    rating: 5,
  },
  {
    quote: 'New roof done in a day and a half, yard cleaner than they found it. You can tell it is family-run.',
    who: 'Homeowner, Alpharetta',
    source: 'google',
    rating: 5,
  },
];
