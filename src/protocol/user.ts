// User reputation and persistent user representation.
// Ported from mostro-core 0.14.3 `src/rating.rs` and `src/user.rs`.

/** User reputation snapshot, suitable for publishing as Nostr tags. */
export interface Rating {
  total_reviews: number;
  total_rating: number;
  last_rating: number;
  max_rate: number;
  min_rate: number;
}

/**
 * Build a Rating from its individual components.
 * Note: argument order mirrors `Rating::new` in mostro-core.
 */
export function newRating(
  total_reviews: number,
  total_rating: number,
  last_rating: number,
  min_rate: number,
  max_rate: number,
): Rating {
  return { total_reviews, total_rating, last_rating, min_rate, max_rate };
}

/** Public snapshot of a user's reputation shared with peers during a trade. */
export interface UserInfo {
  rating: number;
  reviews: number;
  operating_days: number;
}

/** Database representation of a Mostro user. */
export interface User {
  pubkey: string;
  is_admin: number;
  admin_password: string | null;
  is_solver: number;
  is_banned: number;
  category: number;
  last_trade_index: number;
  total_reviews: number;
  total_rating: number;
  last_rating: number;
  max_rating: number;
  min_rating: number;
  created_at: number;
}

/**
 * Record a new rating and refresh the aggregates. Mirrors `User::update_rating`:
 * first vote weighted 1/2, subsequent votes incremental running average.
 * Returns an updated copy of the input rating aggregates.
 */
export function updateRating(rating: number, state: {
  total_reviews: number;
  total_rating: number;
  last_rating: number;
  max_rating: number;
  min_rating: number;
}): {
  total_reviews: number;
  total_rating: number;
  last_rating: number;
  max_rating: number;
  min_rating: number;
} {
  const total_reviews = state.total_reviews + 1;
  const old_rating = state.total_rating;
  let total_rating: number;
  let max_rating = state.max_rating;
  let min_rating = state.min_rating;

  if (total_reviews <= 1) {
    total_rating = rating / 2.0;
    max_rating = rating;
    min_rating = rating;
  } else {
    total_rating = old_rating + (state.last_rating - old_rating) / total_reviews;
    if (max_rating < rating) {
      max_rating = rating;
    }
    if (min_rating > rating) {
      min_rating = rating;
    }
  }

  return { total_reviews, total_rating, last_rating: rating, max_rating, min_rating };
}