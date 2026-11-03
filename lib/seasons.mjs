// Seasons and holidays for the terminal: the same calendar and colours as the desktop app (atlias-max/src/shared/accents.mjs).
// Presentation only. No model request, billing or permission decisions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeOffered } from './edition.mjs';

export const COLOURS = { gold: '#FFD700', red: '#FF5A4D', orange: '#FF9A2B', green: '#3DDC84', blue: '#4DA3FF', indigo: '#8A8DFF', violet: '#C77DFF', brown: '#C08457', white: '#F2F2F2' };
export const OCCASIONS = {
  spring: { label: 'Spring', base: '#F78FB3' }, summer: { label: 'Summer', base: '#FFB703' }, autumn: { label: 'Autumn', base: '#C8842F' }, winter: { label: 'Winter', base: '#7CC6F2' },
  newyear: { label: 'New Year', base: '#E8C547', greeting: 'Happy New Year!' },
  valentines: { label: 'Valentine\'s Day', base: '#FF5C8A', greeting: 'Happy Valentine\'s Day!' },
  stpatricks: { label: 'St. Patrick\'s Day', base: '#2ECC71', greeting: 'Happy St. Patrick\'s Day!' },
  easter: { label: 'Easter', base: '#C4A7FF', greeting: 'Happy Easter!' },
  halloween: { label: 'Halloween', base: '#FF7518', greeting: 'Happy Halloween!' },
  birthday: { label: 'Atlias\'s birthday', base: '#6C8CFF', greeting: 'Today is Atlias\'s birthday!' },
  thanksgiving: { label: 'Thanksgiving', base: '#B5651D', greeting: 'Happy Thanksgiving!' },
  christmas: { label: 'Christmas', base: '#E0323F', greeting: 'Merry Christmas!' },
};
export const themeColor = (name) => COLOURS[name] || OCCASIONS[name]?.base;

// Atlias was finished on 1 November 2026, so that is its birthday until release day replaces it.
const OCCASION_DATES = { birthday: '11-01', halloween: '10-31', spring: '03-01', summer: '06-01', autumn: '09-01', winter: '12-01' };
const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
const monthDay = (id, dates) => (dates[id] || OCCASION_DATES[id]).split('-').map(Number);
// Easter Sunday, by the Anonymous Gregorian computus.
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(year, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
}
function holidayOn(date, dates) {
  const y = date.getFullYear(), m = date.getMonth(), d = date.getDate();
  const day = Date.UTC(y, m, d) / 86400000;
  const within = (from, to) => day >= from && day <= to;
  const at = (month, n) => Date.UTC(y, month, n) / 86400000;
  const on = (id) => { const [month, n] = monthDay(id, dates); return at(month - 1, n); };
  if (day === on('birthday')) return 'birthday';
  if ((m === 11 && d === 31) || (m === 0 && d === 1)) return 'newyear';
  if (within(at(1, 12), at(1, 14))) return 'valentines';
  if (within(at(2, 15), at(2, 17))) return 'stpatricks';
  const easter = easterSunday(y);
  const easterDay = Date.UTC(y, easter.getMonth(), easter.getDate()) / 86400000;
  if (within(easterDay - 2, easterDay + 1)) return 'easter';
  if (within(on('halloween') - 6, on('halloween'))) return 'halloween';
  const thanksgiving = 1 + ((11 - new Date(y, 10, 1).getDay()) % 7) + 21;
  if (within(at(10, thanksgiving - 1), at(10, thanksgiving + 1))) return 'thanksgiving';
  if (within(at(11, 18), at(11, 26))) return 'christmas';
  return null;
}
function seasonOn(date, south, dates) {
  const y = date.getFullYear();
  const starts = [y, y - 1].flatMap((year) => SEASONS.map((id, index) => { const [m, d] = monthDay(id, dates); return { index, from: new Date(year, m - 1, d) }; }));
  const { index } = starts.filter((s) => s.from <= date).sort((a, b) => b.from - a.from)[0];
  return SEASONS[south ? (index + 2) % 4 : index];
}
// Today's season, then today's holiday if there is one.
export const occasionsOn = (date, south = false, dates = {}) => [seasonOn(date, south, dates), holidayOn(date, dates)].filter(Boolean);

// The hemisphere and moved days come from the desktop app's settings, so both show the same theme.
function desktopCalendar() {
  const data = process.platform === 'win32' ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  try {
    const p = JSON.parse(fs.readFileSync(path.join(data, 'Atlias Max', 'app-settings.json'), 'utf8'));
    return { south: p.seasonSouth === true, dates: Object.fromEntries(Object.entries(p.occasionDates || {}).filter(([id, day]) => id in OCCASION_DATES && /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(day))) };
  } catch { return { south: false, dates: {} }; }
}
const today = ({ date = new Date(), founder = claudeOffered(), calendar = desktopCalendar() } = {}) => occasionsOn(date, calendar.south, founder ? calendar.dates : {});

// What the terminal wears. accentColor 'atlias' follows the calendar unless seasonalThemes is off. A season or
// holiday theme is only for its time, except in the founders edition, which can wear any of them whenever it likes.
export function activeTheme(ui = {}, options = {}) {
  const on = today(options), founder = options.founder ?? claudeOffered();
  const value = ui.accentColor || 'atlias', follow = ui.seasonalThemes !== false;
  const theme = OCCASIONS[value] ? (founder || on.includes(value) ? value : follow ? on.at(-1) : 'atlias') : value === 'atlias' && follow ? on.at(-1) : value;
  return { theme, hat: OCCASIONS[theme] ? theme : null, greeting: on.includes(theme) ? OCCASIONS[theme]?.greeting || '' : '' };
}
// Every theme /theme can choose right now.
export function themeChoices(options = {}) {
  const on = today(options), founder = options.founder ?? claudeOffered();
  return ['auto', 'atlias', ...Object.keys(COLOURS), ...Object.keys(OCCASIONS).filter((id) => founder || on.includes(id))];
}
