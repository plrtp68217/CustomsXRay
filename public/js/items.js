/**
 * items.js — shared-модуль данных для сценария «Таможня: Досмотр машины».
 *
 * LEGAL_GOODS — легальные товары (форма + вес).
 * CONTRABAND  — виды контрабанды (форма + вес).
 * CAR_SLOTS   — 6 слотов груза в машине (2 ряда × 3 колонки).
 *               row 0 = передний (виднее на рентгене, перекрывает задний),
 *               row 1 = задний (перекрыт передним).
 * CAR_BODY    — силуэт машины (вид сбоку) для отрисовки.
 *
 * Форма — полигон [x,y] в локальных координатах (центр ~ 0,0).
 */
(function (root) {
  'use strict';

  function rect(w, h) {
    return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  }

  const LEGAL_GOODS = [
    { id: 'box',         name: 'Коробка',     shape: rect(70, 70), weight: 25 },
    { id: 'crate',       name: 'Ящик',        shape: rect(95, 80), weight: 55 },
    { id: 'suit',        name: 'Чемодан',     shape: rect(80, 55), weight: 18 },
    { id: 'electronics', name: 'Электроника', shape: rect(70, 45), weight: 14 },
    { id: 'food',        name: 'Продукты',    shape: rect(65, 65), weight: 20 },
    { id: 'clothes',     name: 'Одежда',      shape: rect(75, 40), weight: 7  },
    { id: 'tools',       name: 'Инструменты', shape: rect(90, 50), weight: 38 },
    { id: 'books',       name: 'Книги',       shape: rect(60, 55), weight: 28 }
  ];

  const CONTRABAND = [
    { id: 'pistol', name: 'Пистолет',  weight: 10, shape: [
        [-40, -16], [22, -16], [22, -6], [40, -6],
        [40, 6], [22, 6], [22, 26], [-8, 26],
        [-8, 16], [-40, 16] ] },
    { id: 'drugs',  name: 'Наркотики', weight: 4,  shape: rect(55, 40) },
    { id: 'cash',   name: 'Наличные',  weight: 2,  shape: rect(60, 35) },
    { id: 'gold',   name: 'Золото',    weight: 40, shape: [[-35, -18], [35, -18], [28, 18], [-28, 18]] }
  ];

  // Слоты груза в кузове (центр машины ~ 0,0).
  const CAR_SLOTS = [
    { slot: 0, col: 0, row: 0, x: -135, y:  22 },
    { slot: 1, col: 1, row: 0, x:    0, y:  22 },
    { slot: 2, col: 2, row: 0, x:  135, y:  22 },
    { slot: 3, col: 0, row: 1, x: -135, y: -22 },
    { slot: 4, col: 1, row: 1, x:    0, y: -22 },
    { slot: 5, col: 2, row: 1, x:  135, y: -22 }
  ];

  // Силуэт машины (грузовой фургон, вид сбоку).
  const CAR_BODY = [
    [-220, -78], [ 220, -78], [ 220,  60], [ 160,  60], [ 160,  30],
    [ 150, -95], [  60,-100], [  20,-105], [- 60,-105], [- 80,-100],
    [-150, -95], [-160,  30], [-220,  60]
  ];

  function goodById(id) { return LEGAL_GOODS.find(g => g.id === id); }
  function contrabandById(id) { return CONTRABAND.find(c => c.id === id); }

  const API = { LEGAL_GOODS, CONTRABAND, CAR_SLOTS, CAR_BODY, goodById, contrabandById, rect };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.Cargo = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);