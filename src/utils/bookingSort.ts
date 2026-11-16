import { Booking } from '../types';

export function getTodayDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Sorts bookings from the nearest upcoming booking to the farthest,
 * keeping past-due active bookings and completed/cancelled bookings below.
 */
export function sortBookingsByNearest(bookings: Booking[]): Booking[] {
  const todayStr = getTodayDateString();

  const getBucket = (b: Booking): number => {
    const isFinished = b.status === 'مكتمل' || b.status === 'ملغى';
    if (!isFinished && (b.date || '') >= todayStr) return 0; // Upcoming active (nearest -> farthest)
    if (!isFinished) return 1; // Past active (most recent -> oldest)
    return 2; // Completed or cancelled (nearest/most recent -> oldest)
  };

  return [...bookings].sort((a, b) => {
    const bucketA = getBucket(a);
    const bucketB = getBucket(b);

    if (bucketA !== bucketB) {
      return bucketA - bucketB;
    }

    const dateA = a.date || '';
    const dateB = b.date || '';

    if (dateA !== dateB) {
      // Bucket 0 (upcoming): ascending (nearest date first)
      if (bucketA === 0) {
        return dateA.localeCompare(dateB);
      }
      // Bucket 1 & 2 (past / completed): descending (closest to today first)
      return dateB.localeCompare(dateA);
    }

    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
}
