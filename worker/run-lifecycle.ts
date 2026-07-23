export const ACTIVATE_SAMPLE_FOR_RUN_SQL = `
  UPDATE samples
  SET status = 'active', updated_by = ?, updated_at = ?
  WHERE id = ?
`;
