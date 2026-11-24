/**
 * RD New (EPSG:28992) to WGS84 latitude/longitude, with the published approximation by
 * Schreutelkamp and Strang van Hees. Accurate to about 1 m in the Netherlands: enough to open
 * a map or street photo at a house, never used for measuring.
 */
const X0 = 155000;
const Y0 = 463000;
const PHI0 = 52.1551744;
const LAM0 = 5.38720621;

const K: [number, number, number][] = [
  [0, 1, 3235.65389],
  [2, 0, -32.58297],
  [0, 2, -0.2475],
  [2, 1, -0.84978],
  [0, 3, -0.0655],
  [2, 2, -0.01709],
  [1, 0, -0.00738],
  [4, 0, 0.0053],
  [2, 3, -0.00039],
  [4, 1, 0.00033],
  [1, 1, -0.00012],
];
const L: [number, number, number][] = [
  [1, 0, 5260.52916],
  [1, 1, 105.94684],
  [1, 2, 2.45656],
  [3, 0, -0.81885],
  [1, 3, 0.05594],
  [3, 1, -0.05607],
  [0, 1, 0.01199],
  [3, 2, -0.00256],
  [1, 4, 0.00128],
  [0, 2, 0.00022],
  [2, 0, -0.00022],
  [5, 0, 0.00026],
];

export function rdToWgs84(x: number, y: number): { lat: number; lon: number } {
  const dx = (x - X0) * 1e-5;
  const dy = (y - Y0) * 1e-5;
  const sum = (terms: [number, number, number][]) =>
    terms.reduce((s, [p, q, c]) => s + c * dx ** p * dy ** q, 0);
  return { lat: PHI0 + sum(K) / 3600, lon: LAM0 + sum(L) / 3600 };
}
