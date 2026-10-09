/* WHO OWNS SPACE. Space is the exposure key (the x-ray rotor, the fluoro pedal) and is global,
   but a focused control that types or opens with Space keeps it: a dropdown, a text or number
   field. Sliders, checkboxes and buttons are what is usually still focused after the technique
   was set, and pressing Space there means "expose", so they do not. Before this, a focused
   dropdown fired the x-ray rotor, and in fluoro a focused slider swallowed the pedal. */
const OWNS_SPACE = 'select, textarea, [contenteditable=""], [contenteditable="true"], '
  + 'input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=button])';
export function ownsSpace(el) {
  return !!(el && typeof el.matches === 'function' && el.matches(OWNS_SPACE));
}
