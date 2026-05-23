import { Shape } from 'three';
import type { Shape2D } from './types.ts';

/**
 * Profile factory: converts Shape2D specs to THREE.Shape for ExtrudeGeometry.
 *
 * All profiles are centered at origin (0, 0) in local XY space.
 * For structural profiles (I/T/L/C/cross), standard centroid-ish alignment is used.
 */
export function createProfile(spec: Shape2D): Shape {
  if (spec.kind === 'shape') return spec.shape;

  const shape = new Shape();

  switch (spec.kind) {
    case 'rect': {
      const hw = spec.width / 2;
      const hd = spec.depth / 2;
      shape.moveTo(-hw, -hd);
      shape.lineTo(hw, -hd);
      shape.lineTo(hw, hd);
      shape.lineTo(-hw, hd);
      shape.closePath();
      return shape;
    }

    case 'round': {
      shape.absarc(0, 0, spec.radius, 0, Math.PI * 2, false);
      return shape;
    }

    case 'i': {
      // I-beam: width = flange width, depth = total depth
      const hw = spec.width / 2;
      const hd = spec.depth / 2;
      const fl = spec.flange;        // flange thickness
      const hwe = spec.web / 2;      // half web thickness
      // Trace outline counter-clockwise
      shape.moveTo(-hw, -hd);
      shape.lineTo(hw, -hd);
      shape.lineTo(hw, -hd + fl);
      shape.lineTo(hwe, -hd + fl);
      shape.lineTo(hwe, hd - fl);
      shape.lineTo(hw, hd - fl);
      shape.lineTo(hw, hd);
      shape.lineTo(-hw, hd);
      shape.lineTo(-hw, hd - fl);
      shape.lineTo(-hwe, hd - fl);
      shape.lineTo(-hwe, -hd + fl);
      shape.lineTo(-hw, -hd + fl);
      shape.closePath();
      return shape;
    }

    case 't': {
      // T-section: flange on top
      const hw = spec.width / 2;
      const hd = spec.depth / 2;
      const fl = spec.flange;
      const hwe = spec.web / 2;
      shape.moveTo(-hwe, -hd);
      shape.lineTo(hwe, -hd);
      shape.lineTo(hwe, hd - fl);
      shape.lineTo(hw, hd - fl);
      shape.lineTo(hw, hd);
      shape.lineTo(-hw, hd);
      shape.lineTo(-hw, hd - fl);
      shape.lineTo(-hwe, hd - fl);
      shape.closePath();
      return shape;
    }

    case 'l': {
      // L-angle: equal legs along +X and +Y from corner at (-hw, -hd)
      const hw = spec.width / 2;
      const hd = spec.depth / 2;
      const t = spec.thickness;
      shape.moveTo(-hw, -hd);
      shape.lineTo(hw, -hd);
      shape.lineTo(hw, -hd + t);
      shape.lineTo(-hw + t, -hd + t);
      shape.lineTo(-hw + t, hd);
      shape.lineTo(-hw, hd);
      shape.closePath();
      return shape;
    }

    case 'c': {
      // C-channel: open on +X side
      const hw = spec.width / 2;
      const hd = spec.depth / 2;
      const fl = spec.flange;
      const we = spec.web;
      shape.moveTo(-hw, -hd);
      shape.lineTo(hw, -hd);
      shape.lineTo(hw, -hd + fl);
      shape.lineTo(-hw + we, -hd + fl);
      shape.lineTo(-hw + we, hd - fl);
      shape.lineTo(hw, hd - fl);
      shape.lineTo(hw, hd);
      shape.lineTo(-hw, hd);
      shape.closePath();
      return shape;
    }

    case 'cross': {
      // Plus-shaped cross section
      const hw = spec.width / 2;
      const hd = spec.depth / 2;
      const ht = spec.thickness / 2;
      shape.moveTo(-hw, -ht);
      shape.lineTo(-ht, -ht);
      shape.lineTo(-ht, -hd);
      shape.lineTo(ht, -hd);
      shape.lineTo(ht, -ht);
      shape.lineTo(hw, -ht);
      shape.lineTo(hw, ht);
      shape.lineTo(ht, ht);
      shape.lineTo(ht, hd);
      shape.lineTo(-ht, hd);
      shape.lineTo(-ht, ht);
      shape.lineTo(-hw, ht);
      shape.closePath();
      return shape;
    }
  }

  // Exhaustiveness check
  const _exhaustive: never = spec;
  void _exhaustive;
  return shape;
}

import { resolveSection } from '../../families/sections/index.ts';

/**
 * Backward-compat shim: builds a Shape2D from a shape string + width/depth
 * numbers. New code should use `resolveSection(shape, attrs)` directly so the
 * caller can pass explicit web/flange/thickness params; this wrapper synthesizes
 * the numbers into the `size_x` / `size_y` attrs the families expect.
 */
export function shapeFromAttrs(
  shape: string | undefined,
  sizeX: number,
  sizeY: number,
): Shape2D {
  const { family, params } = resolveSection(shape, {
    size_x: String(sizeX),
    size_y: String(sizeY),
  });
  return family.shape3D(params);
}

/** Preferred API: resolve a Shape2D from the element's full attrs map so
 *  explicit per-section parameters (flange, web, thickness, …) flow through. */
export function shapeFromSectionAttrs(
  shape: string | undefined,
  attrs: Record<string, string>,
): Shape2D {
  const { family, params } = resolveSection(shape, attrs);
  return family.shape3D(params);
}
