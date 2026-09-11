ALTER TABLE `CreditHourSubmission`
  MODIFY `decisionSource` ENUM('AI', 'ADMIN_OVERRIDE', 'ADMIN_CREATED') NULL;

ALTER TABLE `CreditHourDecisionEvent`
  MODIFY `source` ENUM('AI', 'ADMIN_OVERRIDE', 'ADMIN_CREATED') NULL;
