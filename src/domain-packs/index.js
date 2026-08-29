import { DomainPackRegistry } from "./registry.js";
import { procurementPack } from "./procurement.js";
import { candidateReviewPack } from "./candidateReview.js";
import { healthPlanPack } from "./healthPlan.js";
import { genericPack } from "./generic.js";

export { DomainPackRegistry } from "./registry.js";
export { PROCUREMENT_PACK_ID, procurementPack, createProcurementFixture } from "./procurement.js";
export {
  CANDIDATE_PROHIBITED_FIELDS,
  CANDIDATE_REVIEW_PACK_ID,
  classifyCandidateCriterion,
  candidateReviewPack,
  containsCandidateProtectedText,
  createCandidateReviewFixture,
  isOpaqueCandidateIdentifier,
  isCandidateProtectedField,
  redactCandidateSourceDocuments,
} from "./candidateReview.js";
export {
  HEALTH_PLAN_PACK_ID,
  HEALTH_PLAN_PROHIBITED_FIELDS,
  containsHealthPlanProhibitedPurpose,
  healthPlanPack,
  createHealthPlanFixture,
  redactHealthPlanSourceDocuments,
} from "./healthPlan.js";
export { GENERIC_PACK_ID, genericPack, createGenericFixture } from "./generic.js";

export function createDefaultDomainRegistry() {
  return new DomainPackRegistry([procurementPack, candidateReviewPack, healthPlanPack, genericPack]);
}
