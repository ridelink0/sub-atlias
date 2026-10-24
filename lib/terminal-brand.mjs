// Atlo's original 16x16 SVG, cropped to its painted pixels and paired vertically.
// B is Atlias blue; W is an eye. No terminal image protocol or font dependency.
const PIXELS = ['.....BB.....', '....BBBB....', '...BBBBBB...', '..BBBBBBBB..', '..BBWBBWBB..', '..BBWBBWBB..', '.BBBBBBBBBB.', 'BBBBBBBBBBBB', 'B.BBBBBBBB.B', '..BBBBBBBB..', '..B.B..B.B..', '..B.B..B.B..'];
export const WORDMARK = [
  ' ███  █████ █      ███   ███   ████',
  '█   █   █   █       █   █   █ █    ',
  '█████   █   █       █   █████  ███ ',
  '█   █   █   █       █   █   █     █',
  '█   █   █   █████  ███  █   █ ████ ',
];
export function atloRows(paint = (s) => s) {
  return Array.from({ length: 6 }, (_, row) => Array.from({ length: 12 }, (_, col) => {
    const top = PIXELS[row * 2][col], bottom = PIXELS[row * 2 + 1][col];
    if (top === '.' && bottom === '.') return ' ';
    const pixel = top === '.' ? bottom : top;
    return paint(top === '.' ? '▄' : bottom === '.' ? '▀' : '█', pixel === 'W' ? 'eye' : 'mark');
  }).join(''));
}
