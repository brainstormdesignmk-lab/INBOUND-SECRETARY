// THE AVAILABILITY CLAIM — one contract, every caller.
//
// The ack pools ship BOTH genders (availability.ack for „недвижност“, .masc for
// a стан/плац/деловен простор) and rotate their wording, so an assertion that
// spells one ending certifies a variant, not the claim. That produced three
// separate false failures in this suite (the [04:47] rotation serving «се води
// како активен» against a regex that carried only «активн», and the same stem in
// the house and гapсоњera flows).
//
// The fix is not a longer alternation — it is the STEM rule: the claim is
// "available / free / active / on offer / in the records / in the database", and
// every serviceable inflection of those words starts with one of these stems.
// `\p{L}*` is implicit because these are prefixes of the word, not whole words.
//
// PINNED BY A TEST: tests/availability-confirm.test.ts asserts EVERY variant of
// both pools matches this — so a new bank variant that words the claim with a
// word this file does not know fails there, not three flows downstream.
export const AVAILABILITY_CLAIM = /достап|актив|слобод|располага|баз|евиденц/iu;

/** The MASCULINE agreement markers — used as a NEGATIVE assertion on a
 *  feminine property («недвижноста» must never be „достапен“). */
export const MASCULINE_AGREEMENT = /(?<![\p{L}])(?:слободен|активен|достапен|евидентиран|внесен|заведен|продаден|издаден|расположлив)(?![\p{L}])/iu;

/** The FEMININE agreement markers — the mirror negative for a стан row. */
export const FEMININE_AGREEMENT = /(?<![\p{L}])(?:слободна|активна|достапна|евидентирана|внесена|заведена|продадена|издадена)(?![\p{L}])/iu;
