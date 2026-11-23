import { MIN_DATE, MAX_DATE } from './model.js';
// Hours use direct numeric input; minutes remain a compact selector.
const padded = n => String(n).padStart(2, '0');

// A date-only value is a calendar day, not an instant in the device time zone.
export function dateHint(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < MIN_DATE || value > MAX_DATE) return '';
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return value.replaceAll('-', '/') + '（' + '日月火水木金土'[date.getUTCDay()] + '）';
}

const dateHints = new WeakMap();
function refreshDateHint(input) {
  const hint = dateHints.get(input);
  if (hint) {
    hint.textContent = input.validity.valid ? dateHint(input.value) : '';
    hint.hidden = !hint.textContent;
  }
}

export function enhanceDateFields(form) {
  const inputs = [...form.querySelectorAll('input[type="date"]')];
  for (const input of inputs) {
    if (dateHints.has(input)) continue;
    if (!input.parentElement.classList.contains('date-time-control')) {
      const group = input.ownerDocument.createElement('span');
      group.className = 'date-input-control';
      input.before(group);
      group.append(input);
    }
    const hint = input.ownerDocument.createElement('span');
    hint.className = 'date-hint';
    hint.id = 'date-hint-' + (input.name || input.getAttribute('aria-label'));
    input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), hint.id].filter(Boolean).join(' '));
    input.after(hint);
    dateHints.set(input, hint);
    for (const event of ['input', 'change']) input.addEventListener(event, () => refreshDateHint(input));
  }
  const refresh = () => inputs.forEach(refreshDateHint);
  refresh();
  return {refresh};
}

export function enhanceTimeFields(form) {
  let precise = ['start', 'end'].some(name => Number(form.elements[name].value.slice(-2)) % 10 !== 0);
  const controls = [];

  for (const [name, label] of [['start', '開始'], ['end', '終了']]) {
    const source = form.elements[name];
    const group = document.createElement('span');
    group.className = 'date-time-control';
    const date = document.createElement('input');
    date.type = 'date';
    date.min = MIN_DATE;
    date.max = MAX_DATE;
    date.required = true;
    date.setAttribute('aria-label', label + '日');
    const hour = document.createElement('input');
    hour.type = 'number';
    hour.min = '0';
    hour.max = '23';
    hour.step = '1';
    hour.required = true;
    hour.inputMode = 'numeric';
    hour.setAttribute('aria-label', label + '時（24時間）');
    const minute = document.createElement('select');
    minute.setAttribute('aria-label', label + '分');
    source.type = 'hidden';
    source.before(group);
    group.append(date, hour, minute);

    const refresh = () => {
      const value = source.value;
      date.value = value.slice(0, 10);
      refreshDateHint(date);
      hour.value = String(Number(value.slice(11, 13)));
      const current = Number(value.slice(-2));
      const minutes = Array.from({length: precise ? 60 : 6}, (_, i) => i * (precise ? 1 : 10));
      if (!minutes.includes(current)) minutes.push(current);
      minutes.sort((a, b) => a - b);
      minute.replaceChildren(...minutes.map(n=>{
        const option=document.createElement('option');
        option.value=padded(n);option.textContent=padded(n)+'分';return option;
      }));
      minute.value = padded(current);
    };
    const change = () => {
      if (!date.validity.valid || !hour.validity.valid) return;
      source.value = date.value + 'T' + padded(Number(hour.value)) + ':' + minute.value;
      source.onchange?.();
      controls.forEach(update => update());
    };
    for (const control of [date, hour, minute]) control.onchange = change;
    hour.oninput = change;
    controls.push(refresh);
    refresh();
  }

  return {
    get precise() { return precise; },
    setPrecise(value) { precise = value; controls.forEach(update => update()); },
    refresh() { controls.forEach(update => update()); }
  };
}
