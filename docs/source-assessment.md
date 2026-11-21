# Source assessment

Publisher metadata and rights checked on 2026-11-21. The first campaign uses municipal permit feeds. Census is a V1 aggregate candidate. LandSearch is the marketplace assessment. Access evidence covers municipal query transport and Census file availability. Connector activation and data-path smoke are pending.

| Source | Factual eligibility | Policy eligibility |
| --- | --- | --- |
| Austin Issued Construction Permits, `3syk-w9eu` | Suitable for issued municipal permits. Dataset identity, campaign fields, and anonymous query transport verified. | **Eligible** for bounded structured retrieval and reuse of city-produced permit data. The city asks for attribution. [City dataset license and disclaimer](https://data.austintexas.gov/Building-and-Development/Issued-Construction-Permits/3syk-w9eu/about_data), [City Open Data Terms of Use Policy](https://data.austintexas.gov/download/2z87-8uh7/application/pdf) |
| Seattle Building Permits, `76t5-zqzr` | Suitable for issued municipal permits when filtered to rows with an issued date. Dataset identity, campaign fields, and anonymous query transport verified. | **Eligible** for bounded structured retrieval and reuse under the public-domain designation and city open data policy. Follow the city's privacy and public-risk conditions. [City dataset license](https://data.seattle.gov/Built-Environment/Building-Permits/76t5-zqzr/about_data), [City Open Data Policy](https://www.seattle.gov/documents/Departments/Tech/OpenData/COS_OpenDataPolicy.pdf) |
| Census Building Permits Survey (BPS), 2025 county annual file | Suitable for annual residential construction context at county level. The file listing, layout, and direct file response headers are verified. | **Eligible** for reuse of the published aggregate. [Census open data policy](https://www.census.gov/about/policies/open-gov.html) |
| LandSearch marketplace | Candidate for land listings and asking-price evidence. Listing fields and coverage are pending. | **Unsupported** for automated collection without express written permission. Keep the live adapter disabled and use synthetic fixtures for its end-to-end contract. [LandSearch Terms of Use](https://www.landsearch.com/corp/terms) |

## Austin

Austin Development Services publishes a daily Socrata dataset covering 1980 to present. It includes issued building, electrical, mechanical, plumbing, and driveway or sidewalk permits. The catalog lists 68 dataset columns. The portal metadata and query headers also expose ten computed region fields. The portal declares Project ID as the row identifier. Use building permits for comparison with Seattle. Preserve permit type to distinguish related trade permits. The seed `/d/3syk-w9eu` redirected to the dataset on `data.austintexas.gov`. Austin's catalog publishes SODA3 query and export URLs. Use the verified SODA2 path on `data.austintexas.gov`. [Austin zero-row query](https://data.austintexas.gov/resource/3syk-w9eu.json?%24limit=0), [City dataset metadata](https://data.austintexas.gov/Building-and-Development/Issued-Construction-Permits/3syk-w9eu), [publisher's Data.gov metadata](https://catalog.data.gov/dataset/issued-construction-permits)

| Campaign use | Exact API fields and types |
| --- | --- |
| Identity | `project_id` (number), `permit_number` (text). Treat the project ID as the publisher-declared key pending uniqueness checks in the connector. |
| Type and scope | `permittype`, `permit_type_desc`, `permit_class`, `permit_class_mapped`, `work_class`, `description` (text). |
| Dates and status | `applieddate`, `issue_date`, `expiresdate`, `statusdate` (floating timestamp), `status_current` (text). `statusdate` covers changes to status or expiry in AMANDA. A general row-update watermark is pending. |
| Site | `permit_location`, `original_address1`, `tcad_id` (text), `original_zip`, `latitude`, `longitude` (number). Preserve the jurisdiction with the local appraisal identifier. Treat ZIP as a postal code. |
| Project measures | `total_job_valuation`, `housing_units` (number). Treat the valuation as permit evidence. |

The table uses query response types. The catalog calls its floating timestamp fields calendar dates. [Austin dataset metadata](https://data.austintexas.gov/api/views/3syk-w9eu)

The city's Terms of Use Policy offers city data free of charge and without use restrictions. It requests attribution and leaves downstream analysis to the user. The permit dataset carries a public-domain designation. Austin Development Services describes it as an informational feed subject to revision and differences from official department data. Preserve the city attribution, retrieval date, and source URL. Assess any linked third-party content under its own terms. [City Open Data Terms of Use Policy](https://data.austintexas.gov/download/2z87-8uh7/application/pdf), [city terms catalog](https://catalog.data.gov/dataset/city-of-austin-open-data-terms-of-use-policy), [city dataset metadata and disclaimer](https://data.austintexas.gov/api/views/3syk-w9eu)

## Seattle

Seattle Department of Construction and Inspections publishes a daily Socrata dataset with 41 columns for building permits in progress or issued. The seed on `cos-data.seattle.gov` redirected to the dataset path on that host and the same ID resolves on the city's `data.seattle.gov` portal. Socrata's catalog advertises the first host and lists the second as publisher. Both hosts served the SODA2 query. Use `data.seattle.gov` for metadata and queries, which keeps the connector allowlist to one host. The source's earliest complete year is pending. [Seed resolution](https://cos-data.seattle.gov/d/76t5-zqzr), [city dataset metadata](https://data.seattle.gov/Built-Environment/Building-Permits/76t5-zqzr/about_data), [Socrata catalog metadata](https://api.us.socrata.com/api/catalog/v1?ids=76t5-zqzr), [Seattle zero-row query](https://data.seattle.gov/resource/76t5-zqzr.json?%24limit=0)

| Campaign use | Exact API fields and types |
| --- | --- |
| Identity | `permitnum` (text). The publisher describes it as the permit tracking number. |
| Type and scope | `permitclass`, `permitclassmapped`, `permittypemapped`, `permittypedesc`, `description` (text). The description can change before issuance. |
| Dates and status | `applieddate`, `issueddate`, `expiresdate`, `completeddate` (floating timestamp), `statuscurrent` (text). A general row-update watermark is pending. |
| Site | `originaladdress1`, `originalzip`, `development_site` (text), `latitude`, `longitude` (number), `location1` (location). A development site can overlap multiple tax parcels. A parcel join key is pending. |
| Project measures | `estprojectcost`, `housingunits`, `housingunitsadded`, `housingunitsremoved` (number). Cost is an estimate and can be absent. Housing units is the net change. |

The table uses query response types. The catalog calls its floating timestamp fields calendar dates. [Seattle dataset metadata](https://data.seattle.gov/api/views/76t5-zqzr)

Seattle's Open Data Policy §§4.D and 5.1.E allow public access and reuse. The department can require attribution, source version, and disclosure of changes. Under §4.G, the city can mitigate uses that violate privacy, pose risks to the public, or conflict with program goals. Limit the initial field projection to campaign needs and retain provenance. Keep participant and contact fields out of the first campaign. [City Open Data Policy](https://www.seattle.gov/documents/Departments/Tech/OpenData/COS_OpenDataPolicy.pdf)

## Municipal API limits

The Socrata SODA2 API documents anonymous public reads with shared IP throttling. A registered application token raises limits. The consumer guide reports up to 1,000 requests per rolling hour with a token, while the token reference describes abuse-based throttling. Treat these as platform guidance. The anonymous query responses reported no numeric quota or reset. The actual city-specific limits are pending. SODA3 requires an application token or authentication for queries and exports. Keep requests within the free-only run budget, pause on unknown remaining quota, and honor any `Retry-After`. [Consumer API guide](https://dev.socrata.com/consumers/getting-started), [application token reference](https://dev.socrata.com/docs/app-tokens), [SODA3 access requirements](https://dev.socrata.com/docs/verbs)

SODA defaults to 1,000 records per query. Its query reference lists a 50,000 row maximum for SODA 2.0 and no platform `LIMIT` ceiling for versions 2.1 and 3.0. Use bounded pages with deterministic ordering and a unique tie-breaker. Confirm a row-level update watermark in the connector before relying on incremental pagination for completeness. [Socrata LIMIT reference](https://dev.socrata.com/docs/queries/limit)

An anonymous GET with `$limit=0` returned HTTP 200 and an empty JSON array on Austin and both Seattle hosts. The responses included `X-SODA2-Fields`, `X-SODA2-Types`, `ETag`, and `Last-Modified`. They omitted `X-SODA2-Legacy-Types`, so the SODA2 minor version remains unconfirmed. Dataset-level modification headers can support revalidation. [Austin zero-row query](https://data.austintexas.gov/resource/3syk-w9eu.json?%24limit=0), [Seattle zero-row query](https://data.seattle.gov/resource/76t5-zqzr.json?%24limit=0), [Seattle alias zero-row query](https://cos-data.seattle.gov/resource/76t5-zqzr.json?%24limit=0), [API version and header reference](https://dev.socrata.com/docs/endpoints)

The municipal robots files publish a one-second crawl delay for all agents. Their disallow rules leave the tested `/resource/` paths and `/api/views/` metadata paths open. Honor the crawl delay and check robots again before activation. [Austin portal robots](https://data.austintexas.gov/robots.txt), [Austin Data Hub robots](https://datahub.austintexas.gov/robots.txt), [Seattle portal robots](https://data.seattle.gov/robots.txt), [Seattle alias robots](https://cos-data.seattle.gov/robots.txt)

## Census annual county aggregate

Census lists `co2025a.txt` in its annual county downloads with a 2026-05-14 posting date. The comma-delimited file identifies survey year and county geography. It carries building counts, housing unit counts, and valuation by structure size, with estimates that include imputation and separately reported values. Preserve county and survey year with measure type. Use this source for new residential construction trends. Permit-level facts and commercial permit coverage require other sources. [County file index](https://www2.census.gov/econ/bps/County/), [county layout](https://www.census.gov/construction/bps/sample/cntyasc.pdf), [survey methodology](https://www.census.gov/construction/bps/methodology.html)

An anonymous HEAD request returned HTTP 200 on the listed public file, with `Content-Type: text/plain`, `Content-Length: 375314`, and a `Last-Modified` date of 2026-05-14. Use the listed release URL. [2025 county file](https://www2.census.gov/econ/bps/County/co2025a.txt)

The download host's robots file has rules for named crawlers. It has no wildcard group or rule for the selected file path for a connector using its own identity. The host publishes no numeric quota for this file in the checked material. Use one cached copy per release. Census permits public reuse of its open data. Attribute the Census Bureau and preserve the survey, year, and release date. [Census download robots](https://www2.census.gov/robots.txt), [Census open data policy](https://www.census.gov/about/policies/open-gov.html), [Census citation guidance](https://www.census.gov/about/policies/citation.html)

## LandSearch

LandSearch's terms dated 2026-05-18 require express written permission for automated queries, including scraping and crawlers. The limited indexing exception for public search engines and large language models does not cover a product collecting listings for a feed. A free listing page or the platform's license from its contributors supplies no verified ingestion, storage or redistribution grant for this connector. Treat any displayed price as an asking price unless separate transaction evidence proves a sale. The marketplace has no verified eligible free automated quota. The robots file allows all paths, and the terms still require written permission for this use. Keep the live adapter disabled. [LandSearch Terms of Use](https://www.landsearch.com/corp/terms), [LandSearch robots](https://www.landsearch.com/robots.txt)

## Pending connector checks

WP05 needs a bounded data-path smoke for each city and the Census file. The zero-row results establish transport and response shape. Check actual field mapping, key uniqueness, deterministic pagination, row-level update semantics, and safe projections before the first campaign. Census file-body parsing and measure validation remain pending. LandSearch needs a fixture-based contract and stays disabled pending permission.
