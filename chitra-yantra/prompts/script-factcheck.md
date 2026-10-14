Perform a rigorous fact-check on this video script: {{SCRIPT_PATH}}
Cross-reference against: {{RESEARCH_MASTER_PATH}}, {{RESEARCH_PRODUCTION_PATH}}, and the original reports under {{RESEARCH_PASSES_PATH}}

For each factual claim, tag it as:
- VERIFIED — claim is directly supported by cited source (cite the source)
- UNVERIFIED — claim is plausible but not in the research corpus
- UNSOURCED — claim has no support; flag for removal or rewrite
- ARTISTIC — clearly labeled as artistic interpretation

Check each claim against the script-safe production brief first. A citation is not proof: confirm that its direct source supports the wording and scope. Flag any claim that revives barred, held, disputed, or inadequately qualified material. Do not rewrite the script in this stage.

Output a structured fact-check report with:
1. Summary (verified/unverified/unsourced count)
2. Claim-by-claim analysis
3. Recommended rewrites for flagged claims

Save to: {{FACTCHECK_REPORT_PATH}}
