# Import published parcels and permits

Use the local intake command to run **Ownership/transfer lookup** on Cook County sales or **Permit monitoring** on New York City permit issuances. Each observation retains the publisher's record ID, event day, retrieval time, source URL and SHA-256 of the original projected response. The issuing or recording agency supplies the facts. A small selection establishes coverage only for those observations.

## Choose a source

| Profile | Bounded publisher selection | Mapping and limits |
| --- | --- | --- |
| `cook-sales` | Up to five rows from Clerk document `2606427006`, ordered by the Assessor's unique `row_id`. | The county dataset establishes Cook County, FIPS `17031`. `doc_no` identifies the instrument, `pin` preserves the 14-character parcel ID, and `sale_date` is the recording date. One instrument can cover multiple parcels. Reporting can lag. [Data dictionary](https://datacatalog.cookcountyil.gov/api/views/wvhk-k5uv) · [County open-data policy](https://datacatalog.cookcountyil.gov/stories/s/About-Open-Data/pvqg-z4sc/) |
| `nyc-permits` | One DOB Permit Issuance record with permit serial `3790014`. | The serial supplies the original ID and permit number. The borough establishes county, and `issuance_date` supplies the event day. Only the publisher's `ISSUED` status qualifies for this recipe. Preserve the raw status and type. An issuance establishes neither a construction start nor a participant role. [DOB dataset](https://data.cityofnewyork.us/Housing-Development/DOB-Permit-Issuance/ipu4-2q9a) · [NYC use policy](https://www.nyc.gov/opendata/get-started/FAQs) |

The November 21, 2026 source assessment covers free local use of the listed columns. Review the publisher's current policy before registration. If a record has disappeared, retain the gap. These projections supply no current owner, buyer classification, asking price, market inventory or verified contact. Contact enrichment requires independently verified public business channels and current suppression checks. This CLI accepts neither contacts nor full-table downloads.

## Save and inspect a publisher response

Use Node 24 from the repository root. Run `url`, open the printed HTTPS URL in a browser, and save the JSON response unchanged to a private file outside the checkout. Record the actual UTC retrieval time. The printed URL selects only approved columns and limits the number of rows. To select another published instrument or permit, change the identifier filter, preserving the dataset, column names, sort and limit. Use one request per file. Keep the input below 64 KiB and 100 rows.

```sh
intake() { node scripts/campaign-intake/intake.mjs "$@"; }
profile=cook-sales
file="$private_download_dir/parcel-sales.json"
intake url "$profile"
intake inspect "$profile" "$file"
```

Set `private_download_dir` to your private download folder and save the response at `file` before inspection. Validate that the download came directly from the cited publisher and that the selected rows support the field mapping. Inspection prints the SHA-256, row count and observed counties. A checksum identifies the bytes you reviewed. Publisher provenance depends on obtaining those bytes from the official source.

## Register and import locally

Use the provisioned operator environment with the repository dependencies installed, campaign-engine migrations applied, and the private evidence volume mounted. Set `EVIDENCE_STORE_DIR` to its absolute path and supply `MIGRATOR_DATABASE_URL` through your private environment. The CLI accepts the migrator role at `127.0.0.1`. In a private Compose installation, the operator process can share the database container's network namespace to use loopback. Keep credentials out of commands and shell history.

For a database with no published port, the following shell function runs the same command beside the local Compose database. Set `node_image` to an installed Node 24 operator image, `private_download_dir` to the directory holding your reviewed file and `evidence_dir` to the worker's private artifact directory on the host. The image user must have write access there. Supply the loopback migrator URL through the existing operator environment. Use `/input/parcel-sales.json` as the file argument inside the container.

```sh
intake_local() {
  docker run --pull=never --rm --network "container:$(docker compose ps -q db)" \
    --user "$(id -u):$(id -g)" -v "$PWD:/work:ro" -w /work \
    -v "$private_download_dir:/input:ro" -v "$evidence_dir:/evidence" \
    -e MIGRATOR_DATABASE_URL -e EVIDENCE_STORE_DIR=/evidence \
    "$node_image" node scripts/campaign-intake/intake.mjs "$@"
}
```

Use `intake_local` in place of `intake` for the database commands below when using this arrangement.

```sh
intake register "$profile"
intake import "$profile" "$file" "$retrieved_utc" "$sha256"
```

Set `retrieved_utc` to the recorded UTC instant in ISO format ending in `Z`, and `sha256` to the inspected digest. Registration approves the named profile's publisher, terms, county coverage and fields. The database audit records registration, new observations and withdrawals. Import reports inserted and unchanged counts. Retrying the same reviewed download uses the same logical observations. A changed row needs a later retrieval time. A conflicting time or apparent return to a historical revision requires source review. The profiles omit source modification time because the selected fields establish only the event day.

## Preview a campaign

In **Campaigns**, choose the corresponding template. For Cook County, select `17031`, leave the parcel filter empty or enter the exact PIN, and request `apn` and `instrumentId`. For the DOB serial, use the county from inspection, select the status criterion `issued` and request `permitNumber` and `rawStatus`. Leave asset types empty. Choose a lookback that includes the published event day (up to 3,650 days for historical permits). Preview coverage, save the draft, then run. Open a result's evidence and match its source record to the retained response. A partial result identifies unavailable coverage or fields.

If rights change or a source requires suppression, run `intake suppress "$profile"`. The new blocked policy withdraws the entire source from the eligible view. Replays and registration cannot reactivate it. The evidence history stays private. This command operates at source level.
