export interface Intro {
  label: string;
  text: string;
}

// F2 menu: only PREFILLS the input box. You edit and press Enter yourself.
// Nothing here auto-runs — you remain the client in every situation.
export const QUICK_INTROS: Intro[] = [
  { label: 'Купување — почеток', text: 'Здраво, сакам да купам стан.' },
  { label: 'Изнајмување — почеток', text: 'Здраво, сакам да изнајмам стан.' },
  { label: 'Директно евидентен број', text: 'Сакам да прашам за имот со евидентен број 5.' },
  { label: 'Гневен клиент (проверка)', text: 'Ајде, што е ова? Глупаво е!' },
  { label: 'Бара менаџер', text: 'Сакам да зборувам со менаџер, веднаш!' },
  { label: 'Согласување со надомест', text: 'Да, се согласувам со надомест.' },
  { label: 'Одбивање на понуда', text: 'Не ми се допаѓаат овие станови.' },
];
