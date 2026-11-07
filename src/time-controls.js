// Explicit 24-hour selects keep the time display independent of the OS clock format.
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
    date.required = true;
    date.setAttribute('aria-label', label + '日');
    const hour = document.createElement('select');
    hour.setAttribute('aria-label', label + '時（24時間）');
    hour.innerHTML = Array.from({length: 24}, (_, n) => `<option value="${padded(n)}">${padded(n)}時</option>`).join('');
    const minute = document.createElement('select');
    minute.setAttribute('aria-label', label + '分');
    source.type = 'hidden';
    source.before(group);
    group.append(date, hour, minute);

    const refresh = () => {
      const value = source.value;
      date.value = value.slice(0, 10);
      hour.value = value.slice(11, 13);
      const current = Number(value.slice(-2));
      const minutes = Array.from({length: precise ? 60 : 6}, (_, i) => i * (precise ? 1 : 10));
      if (!minutes.includes(current)) minutes.push(current);
      minutes.sort((a, b) => a - b);
      minute.innerHTML = minutes.map(n => `<option value="${padded(n)}">${padded(n)}分</option>`).join('');
      minute.value = padded(current);
    };
    const change = () => {
      source.value = date.value + 'T' + hour.value + ':' + minute.value;
      source.onchange?.();
      controls.forEach(update => update());
    };
    for (const control of [date, hour, minute]) control.onchange = change;
    controls.push(refresh);
    refresh();
  }

  return {
    get precise() { return precise; },
    setPrecise(value) { precise = value; controls.forEach(update => update()); },
    refresh() { controls.forEach(update => update()); }
  };
}
