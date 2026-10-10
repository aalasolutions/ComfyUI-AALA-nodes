import { describe, expect, it } from 'vitest';
import {
  centeredRect,
  draftFromItem,
  editFromDraft,
  formatSeconds,
  mirrorRect,
  rotateRectCcw,
  rotateRectCw,
  trimRange,
} from '../src/state/edit';
import { createItem } from '../src/state/items';
import { parseState, serializeState, defaultState } from '../src/state/schema';

const video = { size: 1, mtime: 1, width: 1920, height: 1080, fps: '24/1', frames: 240, duration: 10 };
const audio = { size: 1, mtime: 1, duration: 8 };
const draft = { rotate: 0 as const, mirror: false, crop: null, trim: null };

describe('crop geometry', () => {
  const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };

  it('rotating four times returns the same rect', () => {
    let turned = rect;
    for (let index = 0; index < 4; index += 1) {
      turned = rotateRectCw(turned);
    }
    expect(turned.x).toBeCloseTo(rect.x);
    expect(turned.y).toBeCloseTo(rect.y);
    const back = rotateRectCcw(rotateRectCw(rect));
    (['x', 'y', 'w', 'h'] as const).forEach((key) => expect(back[key]).toBeCloseTo(rect[key]));
  });

  it('rotates the top-left region to the top-right', () => {
    expect(rotateRectCw({ x: 0, y: 0, w: 0.5, h: 0.25 })).toEqual({ x: 0.75, y: 0, w: 0.25, h: 0.5 });
  });

  it('mirrors horizontally', () => {
    expect(mirrorRect(rect).x).toBeCloseTo(0.6);
  });

  it('centres the largest rect of a pixel ratio', () => {
    const square = centeredRect(1, 1920, 1080);
    expect(square.h).toBe(1);
    expect(square.w * 1920).toBeCloseTo(1080);
    expect(square.x).toBeCloseTo((1 - 1080 / 1920) / 2);
  });
});

describe('edit round trip', () => {
  it('leaves out unchanged fields', () => {
    expect(editFromDraft('video', draft, video, 10)).toEqual({});
    expect(editFromDraft('video', { ...draft, trim: { start: 0, end: 10 } }, video, 10)).toEqual({});
  });

  it('never stores an empty crop', () => {
    expect(editFromDraft('image', { ...draft, crop: { x: 0.2, y: 0, w: 0, h: 0 } }, null, 0)).toEqual({});
  });

  it('stores video trim as frames, end exclusive, within the frame count', () => {
    const edit = editFromDraft('video', { ...draft, trim: { start: 1, end: 20 } }, video, 10);
    expect(edit.trim).toEqual({ start_frame: 24, end_frame: 240 });
  });

  it('keeps audio trim in seconds and drops crop fields', () => {
    const edit = editFromDraft('audio', { ...draft, rotate: 90, crop: { x: 0, y: 0, w: 0.5, h: 1 }, trim: { start: 2, end: 5 } }, audio, 8);
    expect(edit).toEqual({ trim: { start: 2, end: 5 } });
  });

  it('reads back what it writes, and the state stays valid', () => {
    const item = createItem({ path: '/a/clip.mp4', kind: 'video', meta: video }, true);
    item.edit = editFromDraft('video', { rotate: 90, mirror: true, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, trim: { start: 2, end: 4 } }, video, 10);
    const back = draftFromItem(item, video);
    expect(back).toEqual({ rotate: 90, mirror: true, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, trim: { start: 2, end: 4 } });
    const state = defaultState();
    state.groups.video.push(item);
    expect(parseState(serializeState(state)).ok).toBe(true);
  });

  it('reports the kept range as fractions', () => {
    const item = createItem({ path: '/a/clip.mp4', kind: 'video', meta: video }, true);
    item.edit = { trim: { start_frame: 60, end_frame: 120 } };
    expect(trimRange(item, video)).toEqual([0.25, 0.5]);
    const sound = createItem({ path: '/a/a.wav', kind: 'audio', meta: audio }, true);
    sound.edit = { trim: { start: 2, end: 6 } };
    expect(trimRange(sound, audio)).toEqual([0.25, 0.75]);
  });

  it('formats seconds to tenths', () => {
    expect(formatSeconds(65.04)).toBe('1:05.0');
    expect(formatSeconds(3.25)).toBe('0:03.3');
  });
});
