import { describe, expect, it } from 'vitest';
import { sortSlot } from '../src/composables/usePointerSort';

const slots = (count: number, from: number, to: number) => Array.from({ length: count }, (_, index) => sortSlot(index, from, to));

describe('sortSlot', () => {
  it('leaves every card in place when the target is the origin', () => {
    expect(slots(5, 2, 2)).toEqual([0, 1, 2, 3, 4]);
  });

  it('shifts cards back when dragging forward', () => {
    expect(slots(6, 1, 4)).toEqual([0, 4, 1, 2, 3, 5]);
  });

  it('shifts cards forward when dragging back', () => {
    expect(slots(6, 4, 1)).toEqual([0, 2, 3, 4, 1, 5]);
  });

  it('handles the ends of the list', () => {
    expect(slots(4, 0, 3)).toEqual([3, 0, 1, 2]);
    expect(slots(4, 3, 0)).toEqual([1, 2, 3, 0]);
  });
});
