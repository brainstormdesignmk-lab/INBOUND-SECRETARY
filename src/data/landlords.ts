// Private landlord contact info — never exposed to clients in LLM context.
export const LANDLORD_DATA = new Map<number, { name: string; phone: string }>([
  [46, { name: "Ана Петровска", phone: "072-987-654" }],
  [50, { name: "Марко Марковски", phone: "071-111-222" }],
  [52, { name: "Елена Георгиева", phone: "075-333-444" }],
  [53, { name: "Семејство Поповски", phone: "076-123-456" }],
  [63, { name: "Г-дин Стојановски", phone: "075-777-888" }],
  [73, { name: "Г-ѓа Иванова", phone: "078-333-444" }],
  [83, { name: "Karposh Invest", phone: "071-555-666" }],
]);

export const LINA_AVATAR_URL =
  "https://image.cdn2.seaart.me/2024-12-24/ctktavte878c73bl6680-1/e933c1b2ac68e5c4cc9ed09896e3f5db_high.webp";
