# The one definition of family_of: the family of a model id, matched by
# case-insensitive prefix from the shared map in model-families.json. A model
# id may carry a "provider/" path, which is ignored for matching. $families is
# the slurped map; every caller passes it with --slurpfile families.
def family_of:
  (gsub("^\\s+|\\s+$"; "") | sub("^[^/]+/"; "") | ascii_downcase) as $id
  | (($families[0]
     | map(select((.prefix | ascii_downcase) as $prefix | $id | startswith($prefix)))
     | first | .family) // "unknown");
