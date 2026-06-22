/**
 * geometry.js — shared-модуль геометрии (работает и в Node, и в браузере).
 * Полигоны задаются массивом точек [x, y] в локальных координатах.
 */
(function (root) {
  'use strict';

  /**
   * Проверка принадлежности точки многоугольнику (ray casting).
   * @param {number} px
   * @param {number} py
   * @param {number[][]} poly — [[x,y],...]
   * @returns {boolean}
   */
  function pointInPolygon(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      const intersect = ((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /**
   * Площадь многоугольника (формула шнурков), без знака.
   */
  function polygonArea(poly) {
    let s = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      s += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
    }
    return Math.abs(s) / 2;
  }

  /**
   * Bounding box полигона.
   */
  function polygonBBox(poly) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }

  /**
   * Трансформировать полигон: сдвиг (dx,dy) + поворот (rad) вокруг точки (cx,cy).
   */
  function transformPolygon(poly, dx, dy, rot, cx, cy) {
    const cos = Math.cos(rot), sin = Math.sin(rot);
    return poly.map(([x, y]) => {
      const rx = x - cx, ry = y - cy;
      return [cx + dx + rx * cos - ry * sin, cy + dy + rx * sin + ry * cos];
    });
  }

  /**
   * Вычислить % совпадения контрабандного силуэта с полостью.
   * match = площадь перекрытия / площадь контрабанды.
   * Метод: равномерная сетка точек внутри bbox контрабанды, подсчёт тех,
   * что внутри контрабанды и внутри полости.
   * @param {number[][]} contraband — уже трансформированный полигон контрабанды
   * @param {number[][]} cavity — полигон полости (в мировых координатах)
   * @returns {number} 0..1
   */
  function computeMatch(contraband, cavity, samples) {
    samples = samples || 600;
    const bb = polygonBBox(contraband);
    if (bb.w <= 0 || bb.h <= 0) return 0;
    const step = Math.sqrt((bb.w * bb.h) / samples);
    let insideContraband = 0, insideBoth = 0;
    for (let y = bb.minY; y <= bb.maxY; y += step) {
      for (let x = bb.minX; x <= bb.maxX; x += step) {
        if (pointInPolygon(x, y, contraband)) {
          insideContraband++;
          if (pointInPolygon(x, y, cavity)) insideBoth++;
        }
      }
    }
    if (insideContraband === 0) return 0;
    return Math.min(1, insideBoth / insideContraband);
  }

  const Geometry = {
    pointInPolygon,
    polygonArea,
    polygonBBox,
    transformPolygon,
    computeMatch
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Geometry;
  else root.Geometry = Geometry;
})(typeof globalThis !== 'undefined' ? globalThis : this);