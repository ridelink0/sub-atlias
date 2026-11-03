// Atlo's original 16x16 SVG, cropped to its painted pixels and paired vertically.
// B is Atlias blue; W is an eye. No terminal image protocol or font dependency.
// Gev's original Atlo with its four legs (restored 2026-10-31); Atlo stands to the right of the wordmark.
const PIXELS = ['.....BB.....', '....BBBB....', '...BBBBBB...', '..BBBBBBBB..', '..BBWBBWBB..', '..BBWBBWBB..', '.BBBBBBBBBB.', 'BBBBBBBBBBBB', 'B.BBBBBBBB.B', '..BBBBBBBB..', '..B.B..B.B..', '..B.B..B.B..'];
export const WORDMARK = [
  ' ███  █████ █      ███   ███   ████',
  '█   █   █   █       █   █   █ █    ',
  '█████   █   █       █   █████  ███ ',
  '█   █   █   █       █   █   █     █',
  '█   █   █   █████  ███  █   █ ████ ',
];
// Festive hats, laid over Atlo's top rows. H takes the colour in HAT_RGB, W is white, and a dot leaves Atlo showing.
const PARTY = ['.....WW.....', '.....HH.....', '....HHHH....', '...HHHHHH...'];
const TALL = ['............', '...HHHHHH...', '...HHHHHH...', '.HHHHHHHHHH.'];
const HATS = {
  halloween: ['.....HH.....', '....HHHH....', '...HHHHHH...', 'HHHHHHHHHHHH'],
  christmas: ['.......HHW..', '.....HHHH...', '...HHHHHHH..', '..WWWWWWWW..'],
  easter: ['...W....W...', '...W....W...', '...W....W...', '..BBBBBBBB..'],
  birthday: PARTY, newyear: PARTY, stpatricks: TALL, thanksgiving: TALL,
};
export const HAT_RGB = { halloween: [138, 92, 214], christmas: [224, 50, 63], birthday: [255, 92, 138], newyear: [232, 197, 71], stpatricks: [31, 143, 78], thanksgiving: [160, 110, 60] };
// Six rows of twelve cells: { ch, kind } for each painted cell, null for each empty one.
export function atloCells(wearing = null) {
  const hat = HATS[wearing] || [];
  const pixels = PIXELS.map((line, y) => hat[y] ? [...line].map((p, x) => hat[y][x] === '.' ? p : hat[y][x]).join('') : line);
  return Array.from({ length: 6 }, (_, row) => Array.from({ length: 12 }, (_, col) => {
    const top = pixels[row * 2][col], bottom = pixels[row * 2 + 1][col];
    if (top === '.' && bottom === '.') return null;
    const pixel = top === '.' ? bottom : top;
    return { ch: top === '.' ? '▄' : bottom === '.' ? '▀' : '█', kind: pixel === 'W' ? 'eye' : pixel === 'H' ? 'hat' : 'mark' };
  }));
}
export function atloRows(paint = (s) => s, wearing = null) {
  return atloCells(wearing).map((row) => row.map((cell) => cell ? paint(cell.ch, cell.kind) : ' ').join(''));
}
