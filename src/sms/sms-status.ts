/**
 * Delivery updates only move forward.
 * A later DELIVERED report still replaces FAILED. DELIVERED never goes backwards.
 */
export function mergeDeliveryStatus(current: string, incoming: string): string {
  if (current === 'DELIVERED') return 'DELIVERED';
  if (incoming === 'DELIVERED') return 'DELIVERED';
  if (current === 'FAILED') return 'FAILED';
  if (incoming === 'FAILED') {
    if (
      current === 'SENT' ||
      current === 'SENT_MOCK' ||
      current === 'UNCERTAIN' ||
      current === 'SENDING' ||
      current === 'PENDING'
    ) {
      return 'FAILED';
    }
    return current;
  }
  if (
    (incoming === 'SENT' || incoming === 'SENT_MOCK') &&
    (current === 'PENDING' || current === 'SENDING' || current === 'UNCERTAIN')
  ) {
    return incoming;
  }
  return current;
}
