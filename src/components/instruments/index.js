import {
  CausalTraceInstrument,
  ComparisonMatrixInstrument,
  MetricWaterfallInstrument,
  RiskFrontierInstrument,
  ScoreBreakdownInstrument,
  SensitivityPlotInstrument,
  TimelineInstrument,
  WeightedCriteriaInstrument,
} from "./AnalysisInstruments.jsx";
import {
  BiasShieldInstrument,
  ComplianceGateWallInstrument,
  ConstraintGateInstrument,
  DecisionBriefInstrument,
  OutcomeSealInstrument,
  ProtectedInvariantsInstrument,
  StakeholderMandateInstrument,
} from "./DecisionInstruments.jsx";
import {
  CandidateRequirementCoverageInstrument,
  FormularyCoverageTableInstrument,
  MissingVerificationDocketInstrument,
  ParetoFrontierInstrument,
  PlanCostWaterfallInstrument,
  ProviderNetworkCheckInstrument,
  TotalCostWaterfallInstrument,
  VendorLanesInstrument,
  VerifiedExperienceTimelineInstrument,
} from "./DomainInstruments.jsx";
import {
  ClaimInterpretationInstrument,
  ContradictionDocketInstrument,
  DataQualityDocketInstrument,
  EvidenceExcerptInstrument,
  MissingEvidenceInstrument,
  PinnedContextInstrument,
  SourcePreviewInstrument,
} from "./EvidenceInstruments.jsx";
import {
  ConcessionSetInstrument,
  ScenarioControlsInstrument,
  UtilizationScenarioInstrument,
} from "./ScenarioInstruments.jsx";

export const INSTRUMENT_COMPONENTS = Object.freeze({
  "protected-invariants": ProtectedInvariantsInstrument,
  "pinned-context": PinnedContextInstrument,
  "evidence-excerpt": EvidenceExcerptInstrument,
  "source-preview": SourcePreviewInstrument,
  "claim-interpretation": ClaimInterpretationInstrument,
  "constraint-gate": ConstraintGateInstrument,
  "outcome-seal": OutcomeSealInstrument,
  "causal-trace": CausalTraceInstrument,
  "contradiction-docket": ContradictionDocketInstrument,
  "missing-evidence": MissingEvidenceInstrument,
  "comparison-matrix": ComparisonMatrixInstrument,
  "score-breakdown": ScoreBreakdownInstrument,
  "metric-waterfall": MetricWaterfallInstrument,
  "scenario-controls": ScenarioControlsInstrument,
  "sensitivity-plot": SensitivityPlotInstrument,
  timeline: TimelineInstrument,
  "risk-frontier": RiskFrontierInstrument,
  "stakeholder-mandate": StakeholderMandateInstrument,
  "decision-brief": DecisionBriefInstrument,
  "data-quality-docket": DataQualityDocketInstrument,
  "vendor-lanes": VendorLanesInstrument,
  "compliance-gate-wall": ComplianceGateWallInstrument,
  "tco-waterfall": TotalCostWaterfallInstrument,
  "concession-set": ConcessionSetInstrument,
  "candidate-requirement-coverage": CandidateRequirementCoverageInstrument,
  "verified-experience-timeline": VerifiedExperienceTimelineInstrument,
  "missing-verification-docket": MissingVerificationDocketInstrument,
  "bias-shield": BiasShieldInstrument,
  "plan-cost-waterfall": PlanCostWaterfallInstrument,
  "provider-network-check": ProviderNetworkCheckInstrument,
  "formulary-coverage-table": FormularyCoverageTableInstrument,
  "utilization-scenario": UtilizationScenarioInstrument,
  "weighted-criteria": WeightedCriteriaInstrument,
  "pareto-frontier": ParetoFrontierInstrument,
});

export function getInstrumentComponent(type) {
  return INSTRUMENT_COMPONENTS[type] ?? null;
}

export * from "./InstrumentFrame.jsx";

