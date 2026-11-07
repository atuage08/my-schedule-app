import { MIN_DATE, MAX_DATE } from './model.js';
// Hours use direct numeric input; minutes remain a compact selector.
const padded = n => String(n).padStart(2, '0');

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
      hour.value = String(Number(value.slice(11, 13)));
      const current = Number(value.slice(-2));
      const minutes = Array.from({length: precise ? 60 : 6}, (_, i) => i * (precise ? 1 : 10));
      if (!minutes.includes(current)) minutes.push(current);
      minutes.sort((a, b) => a - b);
      minute.innerHTML = minutes.map(n => `<option value="${padded(n)}">${padded(n)}分</option>`).join('');
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
