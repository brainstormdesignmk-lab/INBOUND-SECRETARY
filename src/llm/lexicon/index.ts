/**
 * THE PER-FAMILY LEXICON.
 *
 * One module per word family that more than one detector needs. A detector
 * that answers "which category / which service / what does «беше» mean / is
 * this a point or an area?" must import from here instead of spelling the
 * words out again — two lists of the same family always drift, and a drifted
 * list is an appliance defect that shows up as a lane answering the wrong
 * question for one spelling only (AGENTS.md §4r).
 *
 * Add a family HERE, with its readers, and a sweep in
 * `tests/lexicon-agreement.test.ts` that drives every consumer.
 */

export * from './text';
export * from './property';
export * from './service';
export * from './memory';
export * from './place';
export * from './commitment';
