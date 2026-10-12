import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";

/** Query projection only, not authentication or a permission token. The owned
 * adapter must check its privately issued original Request in the same BEGIN.
 * Disabled control produces no visible rows even with fabricated subject text.
 * Membership/admin/creator labels never substitute for the explicit mapping. */
export function sampleVisibilityProjection(input: Readonly<RequestSubjectFacts>, schemaVersion: 1 | 2 = 1) {
  // Pure closed query spelling only. Schema choice grants no permission; the
  // owning adapter must pair it with actual same-BEGIN Request admission.
  if (schemaVersion !== 1 && schemaVersion !== 2) throw new TypeError("Invalid Sample visibility schema");
  const { provider, issuer, subject } = input;
  if ((provider !== "access" && provider !== "local") || !canonicalIdentityText(issuer, 2048)
    || !canonicalIdentityText(subject, 256)) throw new TypeError("Invalid Sample visibility projection");
  return Object.freeze({
    bindings: Object.freeze([provider, issuer, subject]),
    cte: `current_sample_member AS MATERIALIZED (
      SELECT m.member_id FROM collaboration_identities i
      JOIN collaboration_members m ON m.member_id=i.member_id
      WHERE i.provider=? AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'
        AND EXISTS(SELECT 1 FROM collaboration_control WHERE singleton=1 AND schema_version=${schemaVersion} AND enforcement='enabled')
    ), visible_samples AS MATERIALIZED (
      SELECT s.id FROM samples s JOIN collaboration_resources r ON r.root_kind='sample' AND r.root_id=s.id
      CROSS JOIN current_sample_member m
      LEFT JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id AND g.member_id=m.member_id
      WHERE s.deleted_at IS NULL AND (r.visibility='workspace' OR
        (g.enabled=1 AND g.capability IN('read','operate','edit','manage')))
    ), visible_sample_templates AS MATERIALIZED (
      SELECT f.id FROM recipe_families f JOIN collaboration_resources r ON r.root_kind='template' AND r.root_id=f.id
      CROSS JOIN current_sample_member m
      LEFT JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id AND g.member_id=m.member_id
      WHERE r.visibility='workspace' OR (g.enabled=1 AND g.capability IN('read','edit','manage'))
    )`,
  });
}
