# Antigravity Skills: Script Enrichment

*These skills allow the Enhancer to surgically modify the Qlik script to add analytical power.*

## 1. Skill: qlik-metadata-inspector
**Description:** Queries the Qlik Engine post-Architect-reload to find "Enrichment Opportunities."
1. Connect to the active session.
2. Query `$Field` and `$Table` system tables.
3. Identify all date-type fields and numeric ranges that would benefit from `Dual()` bucketing.
4. **Output:** A JSON "Enrichment Map" identifying the fields for the Canonical Bridge and the Flags.

## 2. Skill: qlik-canonical-bridge-builder
**Description:** Generates the script to map multiple date fields into a single Canonical Date field.
1. Identify the primary date fields in all Fact tables.
2. Generate a `CanonicalDate_Bridge` table that maps each specific Fact Key (e.g., %Key_Sales, %Key_Shipments) to a shared `%Key_Date`.
3. Update the `LinkTable` to include the `%Key_Date`.

## 3. Skill: qlik-derived-field-generator
**Description:** Injects the `DECLARE FIELD DEFINITION` block into the script.
1. Define a standard calendar template: `Year`, `Month`, `Quarter`, `Week`, `Day`, `MonthYear`.
2. Generate the `DERIVE FIELDS FROM FIELDS [Canonical Date] USING [Calendar_Template]` statement.

## 4. Skill: qlik-dual-logic-injector
**Description:** Injects `Dual()` formatted logic into LOAD statements.
1. Rewrite identified `LOAD` fields to wrap values in `Dual(Text, Number)`.
2. **Example Logic:** `If(Status='Shipped', Dual('Shipped', 1), Dual('Pending', 0)) AS [Shipment Status]`.

## 5. Skill: qlik-asof-table-generator
**Description:** Generates a robust As-Of table for rolling period analysis.
1. Calculate the full range of the `Canonical Date`.
2. Generate the "Reporting Period" records (Current Year, Last Year, Rolling 12).
3. Link these periods to the individual dates to enable point-in-time comparisons.