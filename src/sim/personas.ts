export interface PersonaStep {
  text: string;
  tags?: string[]; // 'interest' marks the message where the owner shows intent to visit
}

export interface Persona {
  key: string;
  name: string;
  channel: string;
  script: PersonaStep[];
}

export const PERSONAS: Persona[] = [
  {
    key: 'goran',
    name: 'Горан Петровски',
    channel: 'viber',
    script: [
      { text: 'Здраво, јас барам стан за купување.' },
      { text: 'Во Карпош, две спални соби, буџет до 80.000 евра.' },
      { text: 'Првиот ми се допаѓа, сакам да го видам.', tags: ['interest'] },
      { text: 'Да, прифаќам, кажете ми како.' },
      { text: 'Горан Петровски, телефон 070 123 456.' },
      { text: 'Сабота во 11 часот ми одговара.' },
    ],
  },
  {
    key: 'elena',
    name: 'Елена Крстевска',
    channel: 'viber',
    script: [
      { text: 'Здраво, сакам да изнајмам стан.' },
      { text: 'Аеродром, една спална соба, до 300 евра месечно.' },
      { text: 'Станот ме интересира, кога може да го разгледам?', tags: ['interest'] },
      { text: 'Ок, во ред, прифаќам.' },
      { text: 'Елена Крстевска, 071 987 654.' },
      { text: 'Петок попладне ми одговара.' },
    ],
  },
  {
    key: 'ana',
    name: 'Ана Стојановска',
    channel: 'viber',
    script: [
      { text: 'Добар ден, сакам да купам стан во Центар.' },
      { text: 'Две спални соби, буџет до 90.000 евра.' },
      { text: 'Имате ли уште некој стан да ми покажете?' }, // must NOT dump a 3rd property
      { text: 'Првиот беше добар, ама сакам да споредам пред да одлучам.' },
      { text: 'Да, првиот, сакам да го видам.', tags: ['interest'] },
      { text: 'Прифаќам, во ред.' },
      { text: 'Ана Стојановска, 072 333 444.' },
      { text: 'Сабота во 12 часот.' },
    ],
  },
  {
    key: 'troll',
    name: 'Нервозен корисник',
    channel: 'viber',
    script: [
      { text: 'Еј, здраво.' },
      { text: 'Ајде бе, глупава си!' },          // strike 1 → warning
      { text: 'Што ме замараш, дебилу!' },       // strike 2 → final warning
      { text: 'Иди земи си, курво!' },           // severe → instant termination, ZERO output
    ],
  },
  {
    key: 'mile',
    name: 'Миле Јовановски',
    channel: 'viber',
    script: [
      { text: 'Здраво, сакам да купам стан.' },
      { text: 'Скопје, три спални, до 120.000 евра.' },
      { text: 'Не ми се допаѓа како работите, јас сум Миле Јовановски, сакам да зборувам со менаџер!' },
    ],
  },
];
