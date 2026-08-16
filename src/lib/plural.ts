// "6 connections", "1 connection".
//
// The word is "connection" rather than "bank" because half of what people
// link is not one: a brokerage, a benefits card, a payments app. Plaid calls
// them Items, which is nobody's word for anything. The app already says
// "Add connection" and "This connection stopped working", so this is the noun
// it had all along.
export function connectionCount(count: number): string {
  return `${count} ${count === 1 ? "connection" : "connections"}`;
}
