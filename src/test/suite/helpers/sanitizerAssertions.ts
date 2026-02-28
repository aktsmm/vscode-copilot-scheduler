import * as assert from "assert";

export function runSharedSanitizerCases(
  sanitize: (message: string) => string,
  expectedRedactedPlaceholder: string,
): void {
  const winQuoted =
    "EACCES: permission denied, open 'C:\\Users\\me\\secret folder\\a b.md'";
  const winQuotedOut = sanitize(winQuoted);
  assert.ok(!winQuotedOut.includes("C:\\Users\\me"));
  assert.ok(winQuotedOut.includes("'a b.md'"));

  const winUnquoted =
    "ENOENT: no such file or directory, open C:\\Users\\me\\a.md";
  const winUnquotedOut = sanitize(winUnquoted);
  assert.ok(!winUnquotedOut.includes("C:\\Users\\me"));
  assert.ok(winUnquotedOut.includes("a.md"));

  const winUnquotedWithSpaces =
    "ENOENT: no such file or directory, open C:/Users/me/secret folder/a b.md";
  const winUnquotedWithSpacesOut = sanitize(winUnquotedWithSpaces);
  assert.ok(!winUnquotedWithSpacesOut.includes("C:/Users/me/secret folder"));
  assert.ok(winUnquotedWithSpacesOut.includes("a b.md"));

  const winUnquotedWithSpacesNoExt =
    "open C:/Users/me/secret folder/private notes";
  const winUnquotedWithSpacesNoExtOut = sanitize(winUnquotedWithSpacesNoExt);
  assert.ok(
    !winUnquotedWithSpacesNoExtOut.includes("C:/Users/me/secret folder"),
  );
  assert.ok(winUnquotedWithSpacesNoExtOut.includes("private notes"));

  const winUnquotedWithSpacesNoExtPeriod =
    "open C:/Users/me/secret folder/private notes.";
  const winUnquotedWithSpacesNoExtPeriodOut = sanitize(
    winUnquotedWithSpacesNoExtPeriod,
  );
  assert.ok(
    !winUnquotedWithSpacesNoExtPeriodOut.includes("C:/Users/me/secret folder"),
  );
  assert.ok(winUnquotedWithSpacesNoExtPeriodOut.includes("private notes."));

  const winUnquotedWithSpacesNoExtExclaim =
    "open C:/Users/me/secret folder/private notes!";
  const winUnquotedWithSpacesNoExtExclaimOut = sanitize(
    winUnquotedWithSpacesNoExtExclaim,
  );
  assert.ok(
    !winUnquotedWithSpacesNoExtExclaimOut.includes("C:/Users/me/secret folder"),
  );
  assert.ok(winUnquotedWithSpacesNoExtExclaimOut.includes("private notes!"));

  const posixQuoted =
    "ENOENT: no such file or directory, open '/Users/me/secret folder/a b.md'";
  const posixQuotedOut = sanitize(posixQuoted);
  assert.ok(!posixQuotedOut.includes("/Users/me/secret folder"));
  assert.ok(posixQuotedOut.includes("'a b.md'"));

  const posixUnquoted = "open /Users/me/a.md";
  const posixUnquotedOut = sanitize(posixUnquoted);
  assert.ok(!posixUnquotedOut.includes("/Users/me/"));
  assert.ok(posixUnquotedOut.includes("a.md"));

  const posixSingleSegment = "open /secret";
  const posixSingleSegmentOut = sanitize(posixSingleSegment);
  assert.ok(!posixSingleSegmentOut.includes("/secret"));
  assert.ok(posixSingleSegmentOut.includes("secret"));

  const posixSingleSegmentStat = "stat /secret";
  const posixSingleSegmentStatOut = sanitize(posixSingleSegmentStat);
  assert.ok(!posixSingleSegmentStatOut.includes("/secret"));
  assert.ok(posixSingleSegmentStatOut.includes("secret"));

  const posixUnquotedWithSpaces = "open /Users/me/secret folder/a b.md";
  const posixUnquotedWithSpacesOut = sanitize(posixUnquotedWithSpaces);
  assert.ok(!posixUnquotedWithSpacesOut.includes("/Users/me/secret folder"));
  assert.ok(posixUnquotedWithSpacesOut.includes("a b.md"));

  const posixUnquotedWithSpacesNoExt =
    "open /Users/me/secret folder/private notes";
  const posixUnquotedWithSpacesNoExtOut = sanitize(
    posixUnquotedWithSpacesNoExt,
  );
  assert.ok(
    !posixUnquotedWithSpacesNoExtOut.includes("/Users/me/secret folder"),
  );
  assert.ok(posixUnquotedWithSpacesNoExtOut.includes("private notes"));

  const posixUnquotedWithSpacesNoExtPeriod =
    "open /Users/me/secret folder/private notes.";
  const posixUnquotedWithSpacesNoExtPeriodOut = sanitize(
    posixUnquotedWithSpacesNoExtPeriod,
  );
  assert.ok(
    !posixUnquotedWithSpacesNoExtPeriodOut.includes("/Users/me/secret folder"),
  );
  assert.ok(posixUnquotedWithSpacesNoExtPeriodOut.includes("private notes."));

  const posixUnquotedWithSpacesNoExtQuestion =
    "open /Users/me/secret folder/private notes?";
  const posixUnquotedWithSpacesNoExtQuestionOut = sanitize(
    posixUnquotedWithSpacesNoExtQuestion,
  );
  assert.ok(
    !posixUnquotedWithSpacesNoExtQuestionOut.includes(
      "/Users/me/secret folder",
    ),
  );
  assert.ok(posixUnquotedWithSpacesNoExtQuestionOut.includes("private notes?"));

  const posixParen = "at foo (/Users/me/a.md:1:2)";
  const posixParenOut = sanitize(posixParen);
  assert.ok(!posixParenOut.includes("/Users/me/"));
  assert.ok(posixParenOut.includes("(a.md:1:2)"));

  const winForward = "open C:/Users/me/a.md";
  const winForwardOut = sanitize(winForward);
  assert.ok(!winForwardOut.includes("C:/Users/me/"));
  assert.ok(winForwardOut.includes("a.md"));

  const winForwardExclaim = "open C:/Users/me/a.md!";
  const winForwardExclaimOut = sanitize(winForwardExclaim);
  assert.ok(!winForwardExclaimOut.includes("C:/Users/me/"));
  assert.ok(winForwardExclaimOut.includes("a.md!"));

  const posixUnquotedQuestion = "open /Users/me/a.md?";
  const posixUnquotedQuestionOut = sanitize(posixUnquotedQuestion);
  assert.ok(!posixUnquotedQuestionOut.includes("/Users/me/"));
  assert.ok(posixUnquotedQuestionOut.includes("a.md?"));

  const winSingleSegment = "open C:/secret";
  const winSingleSegmentOut = sanitize(winSingleSegment);
  assert.ok(!winSingleSegmentOut.includes("C:/secret"));
  assert.ok(winSingleSegmentOut.includes("secret"));

  const winSingleSegmentStat = "stat C:/tmp";
  const winSingleSegmentStatOut = sanitize(winSingleSegmentStat);
  assert.ok(!winSingleSegmentStatOut.includes("C:/tmp"));
  assert.ok(winSingleSegmentStatOut.includes("tmp"));

  const winSingleSegmentMkdir = "mkdir C:/cache";
  const winSingleSegmentMkdirOut = sanitize(winSingleSegmentMkdir);
  assert.ok(!winSingleSegmentMkdirOut.includes("C:/cache"));
  assert.ok(winSingleSegmentMkdirOut.includes("cache"));

  const winSingleSegmentCopyfile = "copyfile C:/cache";
  const winSingleSegmentCopyfileOut = sanitize(winSingleSegmentCopyfile);
  assert.ok(!winSingleSegmentCopyfileOut.includes("C:/cache"));
  assert.ok(winSingleSegmentCopyfileOut.includes("cache"));

  const winSingleSegmentAccess = "access C:/secret";
  const winSingleSegmentAccessOut = sanitize(winSingleSegmentAccess);
  assert.ok(!winSingleSegmentAccessOut.includes("C:/secret"));
  assert.ok(winSingleSegmentAccessOut.includes("secret"));

  const winSingleSegmentChmod = "chmod C:/secret";
  const winSingleSegmentChmodOut = sanitize(winSingleSegmentChmod);
  assert.ok(!winSingleSegmentChmodOut.includes("C:/secret"));
  assert.ok(winSingleSegmentChmodOut.includes("secret"));

  const winSingleSegmentExclaim = "open C:/secret!";
  const winSingleSegmentExclaimOut = sanitize(winSingleSegmentExclaim);
  assert.ok(!winSingleSegmentExclaimOut.includes("C:/secret"));
  assert.ok(winSingleSegmentExclaimOut.includes("secret!"));

  const posixSingleSegmentRename = "rename /secret";
  const posixSingleSegmentRenameOut = sanitize(posixSingleSegmentRename);
  assert.ok(!posixSingleSegmentRenameOut.includes("/secret"));
  assert.ok(posixSingleSegmentRenameOut.includes("secret"));

  const posixSingleSegmentCopyfile = "copyfile /secret";
  const posixSingleSegmentCopyfileOut = sanitize(posixSingleSegmentCopyfile);
  assert.ok(!posixSingleSegmentCopyfileOut.includes("/secret"));
  assert.ok(posixSingleSegmentCopyfileOut.includes("secret"));

  const posixSingleSegmentAccess = "access /secret";
  const posixSingleSegmentAccessOut = sanitize(posixSingleSegmentAccess);
  assert.ok(!posixSingleSegmentAccessOut.includes("/secret"));
  assert.ok(posixSingleSegmentAccessOut.includes("secret"));

  const posixSingleSegmentChmod = "chmod /secret";
  const posixSingleSegmentChmodOut = sanitize(posixSingleSegmentChmod);
  assert.ok(!posixSingleSegmentChmodOut.includes("/secret"));
  assert.ok(posixSingleSegmentChmodOut.includes("secret"));

  const posixSingleSegmentQuestion = "stat /secret?";
  const posixSingleSegmentQuestionOut = sanitize(posixSingleSegmentQuestion);
  assert.ok(!posixSingleSegmentQuestionOut.includes("/secret"));
  assert.ok(posixSingleSegmentQuestionOut.includes("secret?"));

  const uncPath = "open \\\\server\\share\\secret\\a.md";
  const uncOut = sanitize(uncPath);
  assert.ok(!uncOut.includes("\\\\server\\share"));
  assert.ok(uncOut.includes("a.md"));

  const winExtendedPath = "open \\\\?\\C:\\Users\\me\\secret folder\\a b.md";
  const winExtendedPathOut = sanitize(winExtendedPath);
  assert.ok(!winExtendedPathOut.includes("\\\\?\\C:\\Users\\me"));
  assert.ok(winExtendedPathOut.includes("a b.md"));

  const winExtendedUncPath = "open \\\\?\\UNC\\server\\share\\secret\\a.md";
  const winExtendedUncPathOut = sanitize(winExtendedUncPath);
  assert.ok(!winExtendedUncPathOut.includes("\\\\?\\UNC\\server\\share"));
  assert.ok(winExtendedUncPathOut.includes("a.md"));

  const uncNoExtWithSpaces =
    "open \\\\server\\share\\secret folder\\private notes";
  const uncNoExtWithSpacesOut = sanitize(uncNoExtWithSpaces);
  assert.ok(
    !uncNoExtWithSpacesOut.includes("\\\\server\\share\\secret folder"),
  );
  assert.ok(uncNoExtWithSpacesOut.includes("private notes"));

  const uncNoExtWithSpacesPeriod =
    "open \\\\server\\share\\secret folder\\private notes.";
  const uncNoExtWithSpacesPeriodOut = sanitize(uncNoExtWithSpacesPeriod);
  assert.ok(
    !uncNoExtWithSpacesPeriodOut.includes("\\\\server\\share\\secret folder"),
  );
  assert.ok(uncNoExtWithSpacesPeriodOut.includes("private notes."));

  const fileUri = "open file:///C:/Users/me/secret%20folder/a%20b.md";
  const fileUriOut = sanitize(fileUri);
  assert.ok(!fileUriOut.includes("file:///C:/Users/me"));
  assert.ok(fileUriOut.includes("a b.md"));

  const fileUriHost = "open file://server/share/secret/a.md";
  const fileUriHostOut = sanitize(fileUriHost);
  assert.ok(!fileUriHostOut.includes("file://server/share"));
  assert.ok(fileUriHostOut.includes("a.md"));

  const authBearer = "Authorization: Bearer abc.def.ghi";
  const authBearerOut = sanitize(authBearer);
  assert.ok(!authBearerOut.includes("abc.def.ghi"));
  assert.ok(
    authBearerOut.includes(
      `Authorization: Bearer ${expectedRedactedPlaceholder}`,
    ),
  );

  const authBearerNoSpace = "Authorization:Bearer abc.def.ghi";
  const authBearerNoSpaceOut = sanitize(authBearerNoSpace);
  assert.ok(!authBearerNoSpaceOut.includes("abc.def.ghi"));
  assert.ok(
    authBearerNoSpaceOut.includes(
      `Authorization:Bearer ${expectedRedactedPlaceholder}`,
    ),
  );

  const authBearerQuoted = 'Authorization: Bearer "abc def.ghi"';
  const authBearerQuotedOut = sanitize(authBearerQuoted);
  assert.ok(!authBearerQuotedOut.includes("abc def.ghi"));
  assert.ok(
    authBearerQuotedOut.includes(
      `Authorization: Bearer ${expectedRedactedPlaceholder}`,
    ),
  );

  const authBearerCaseVariant = "authorization: bearer 'abc def'";
  const authBearerCaseVariantOut = sanitize(authBearerCaseVariant);
  assert.ok(!authBearerCaseVariantOut.includes("abc def"));
  assert.ok(
    authBearerCaseVariantOut.includes(
      `authorization: bearer ${expectedRedactedPlaceholder}`,
    ),
  );

  const tokenQuery =
    "request failed: https://example.com/api?token=abc123&mode=1";
  const tokenQueryOut = sanitize(tokenQuery);
  assert.ok(!tokenQueryOut.includes("token=abc123"));
  assert.ok(tokenQueryOut.includes(`token=${expectedRedactedPlaceholder}`));

  const passwordValue = "login failed password=mySecret123";
  const passwordValueOut = sanitize(passwordValue);
  assert.ok(!passwordValueOut.includes("mySecret123"));
  assert.ok(
    passwordValueOut.includes(`password=${expectedRedactedPlaceholder}`),
  );

  const webUrl = "see https://example.com/path";
  const webUrlOut = sanitize(webUrl);
  assert.strictEqual(webUrlOut, webUrl);

  const narrativeText = "Usage note: use /home and C:/ as placeholders only.";
  const narrativeTextOut = sanitize(narrativeText);
  assert.strictEqual(narrativeTextOut, narrativeText);

  const windowsNarrative = "Path is C:/tmp for example.";
  const windowsNarrativeOut = sanitize(windowsNarrative);
  assert.strictEqual(windowsNarrativeOut, windowsNarrative);

  const veryLong = "open /Users/me/secret/a.md " + "x".repeat(12000);
  const veryLongOut = sanitize(veryLong);
  assert.ok(!veryLongOut.includes("/Users/me/secret"));
  assert.ok(veryLongOut.includes("a.md"));
  assert.ok(veryLongOut.length <= 8000);

  const overInputLimit = "open /Users/me/secret/a.md " + "x".repeat(20000);
  const overInputLimitOut = sanitize(overInputLimit);
  assert.ok(!overInputLimitOut.includes("/Users/me/secret"));
  assert.ok(overInputLimitOut.includes("a.md"));
  assert.ok(overInputLimitOut.length <= 8000);

  const boundaryInput =
    "x".repeat(7990) + " open /Users/me/secret/private-notes.md";
  const boundaryOut = sanitize(boundaryInput);
  assert.ok(boundaryOut.length <= 8000);
  assert.ok(!boundaryOut.includes("/Users/me/secret"));
}

export function runSanitizerParityCases(
  left: (message: string) => string,
  right: (message: string) => string,
): void {
  const cases = [
    "ENOENT: no such file or directory, open 'C:\\Users\\me\\secret folder\\a b.md'",
    "open /Users/me/secret folder/private notes?",
    "open \\\\server\\share\\secret folder\\private notes.",
    'Authorization: Bearer "abc def.ghi"',
    "request failed: https://example.com/api?token=abc123&mode=1",
    "login failed password=mySecret123",
    "Path is C:/tmp for example.",
    "Usage note: use /home and C:/ as placeholders only.",
  ];

  for (const input of cases) {
    assert.strictEqual(
      left(input),
      right(input),
      `Sanitizer output mismatch for input: ${input}`,
    );
  }
}
