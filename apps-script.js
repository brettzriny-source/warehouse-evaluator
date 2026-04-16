// ══════════════════════════════════════════════════════════════════════
// Jetson Warehouse Site Evaluator — Google Apps Script
// ══════════════════════════════════════════════════════════════════════
// This script handles:
//   1. Saving evaluation PDFs + photos to Google Drive folders
//   2. Logging evaluation summaries to a Google Sheet (for Portfolio integration)
//   3. Serving evaluation data via GET (for Real Estate Portfolio to fetch)
//
// SETUP:
//   1. Replace ROOT_FOLDER_ID with your Google Drive folder ID
//   2. Replace SHEET_ID with your Google Sheet ID (create a new sheet with a tab named "Evaluations")
//   3. Deploy as Web App: Execute as "Me", Access "Anyone"
//   4. On first run, authorize Drive + Sheets access when prompted
// ══════════════════════════════════════════════════════════════════════

var ROOT_FOLDER_ID = "1bZZDFj0HycamRivMl1g-1l8f5UcGvPV-";  // <-- Your Drive folder ID
var SHEET_ID = "YOUR_SHEET_ID_HERE";                          // <-- Create a Google Sheet and paste its ID here
var SHEET_TAB = "Evaluations";                                // <-- Tab name in the sheet

// ─── GET: Return all evaluation data as JSON ───
function doGet(e) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_TAB);

    if (!sheet || sheet.getLastRow() < 2) {
      return ContentService.createTextOutput(JSON.stringify([]))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    var jsonColIdx = headers.indexOf("jsonData");
    var evaluations = [];

    for (var i = 0; i < data.length; i++) {
      try {
        if (jsonColIdx >= 0 && data[i][jsonColIdx]) {
          evaluations.push(JSON.parse(data[i][jsonColIdx]));
        }
      } catch (parseErr) {
        // Skip rows with invalid JSON
      }
    }

    return ContentService.createTextOutput(JSON.stringify(evaluations))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ─── POST: Handle evaluation submissions and photo uploads ───
function doPost(e) {
  try {
    var data = JSON.parse(e.parameter.payload);
    var root = DriveApp.getFolderById(ROOT_FOLDER_ID);

    // ═══ SUBMIT EVALUATION ═══
    if (data.action === "submit_evaluation") {
      // Create subfolder: "PropertyName - Address (Date)"
      var folderName = (data.siteInfo.propertyName || data.siteInfo.address || "Untitled")
        + " - " + (data.siteInfo.address || "")
        + " (" + (data.siteInfo.date || new Date().toISOString().slice(0, 10)) + ")";
      folderName = folderName.replace(/[\/\\:*?"<>|]/g, "");

      // Check if folder already exists (resume case)
      var existing = root.getFoldersByName(folderName);
      var folder = existing.hasNext() ? existing.next() : root.createFolder(folderName);

      // Save PDF report
      if (data.pdfData) {
        var pdfBytes = Utilities.base64Decode(data.pdfData);
        var pdfBlob = Utilities.newBlob(pdfBytes, "application/pdf", data.pdfFileName || "evaluation.pdf");
        folder.createFile(pdfBlob);
      }

      // Save JSON backup
      var jsonBlob = Utilities.newBlob(
        JSON.stringify({
          siteInfo: data.siteInfo,
          sections: data.sections,
          gutFeelScore: data.gutFeelScore,
          gutFeelNotes: data.gutFeelNotes,
          tiRequests: data.tiRequests,
          miscNotes: data.miscNotes,
          overallScore: data.overallScore,
          submittedAt: new Date().toISOString()
        }, null, 2),
        "application/json",
        folderName + ".json"
      );
      folder.createFile(jsonBlob);

      // ─── Log to Google Sheet for Portfolio integration ───
      logEvaluationToSheet(data);

      // Save folder ID for photo uploads
      PropertiesService.getScriptProperties().setProperty(
        "lastFolder_" + data.siteInfo.date + "_" + (data.siteInfo.propertyName || ""),
        folder.getId()
      );

      return ContentService.createTextOutput(JSON.stringify({ success: true, folderId: folder.getId() }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ═══ UPLOAD PHOTO ═══
    if (data.action === "upload_photo") {
      var key = "lastFolder_" + data.siteKey.date + "_" + (data.siteKey.propertyName || "");
      var folderId = PropertiesService.getScriptProperties().getProperty(key);
      var folder;

      if (folderId) {
        folder = DriveApp.getFolderById(folderId);
      } else {
        var searchName = (data.siteKey.propertyName || data.siteKey.address || "Untitled");
        var folders = root.getFoldersByName(searchName);
        folder = folders.hasNext() ? folders.next() : root.createFolder(searchName);
      }

      var base64 = data.photoData.replace(/^data:image\/\w+;base64,/, "");
      var photoBytes = Utilities.base64Decode(base64);
      var photoBlob = Utilities.newBlob(photoBytes, "image/jpeg", data.photoName || "photo.jpg");
      folder.createFile(photoBlob);

      return ContentService.createTextOutput(JSON.stringify({ success: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ error: "Unknown action" }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ─── Write evaluation summary to Google Sheet ───
function logEvaluationToSheet(data) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(SHEET_TAB);

    // Create sheet + headers if it doesn't exist
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_TAB);
      sheet.appendRow([
        "timestamp", "propertyName", "address", "city", "state", "zip",
        "date", "evaluator", "overallScore", "gutScore", "gutLabel",
        "askingRate", "availableSF", "yearBuilt", "jsonData"
      ]);
      // Bold the header row
      sheet.getRange(1, 1, 1, 15).setFontWeight("bold");
      sheet.setFrozenRows(1);
    }

    var si = data.siteInfo || {};
    var gutLabels = ["", "Pass", "Below Average", "Average", "Strong Contender", "Top Pick"];
    var gutScore = data.gutFeelScore || 0;

    // Build the full evaluation object that the Portfolio will consume
    var sections = (data.sections || []).map(function(s) {
      var scored = s.criteria.filter(function(c) { return c.score > 0; });
      var avg = scored.length ? scored.reduce(function(a, c) { return a + c.score; }, 0) / scored.length : 0;
      return {
        name: s.name,
        avg: Math.round(avg * 10) / 10,
        criteria: s.criteria,
        measurements: s.measurements
      };
    });

    var evalRecord = {
      id: "eval_" + Date.now(),
      propertyName: si.propertyName || si.address || "Untitled",
      address: si.address || "",
      city: si.city || "",
      state: si.state || "",
      zip: si.zip || "",
      date: si.date || new Date().toISOString().slice(0, 10),
      evaluator: si.evaluator || "",
      overallScore: data.overallScore ? parseFloat(data.overallScore) : 0,
      gutScore: gutScore,
      gutLabel: gutLabels[gutScore] || "",
      askingRate: si.askingRate || "",
      availableSF: si.availableSF || "",
      yearBuilt: si.yearBuilt || "",
      sections: sections,
      tiRequests: data.tiRequests || [],
      miscNotes: data.miscNotes || "",
      submittedAt: new Date().toISOString()
    };

    // Append row: key fields + full JSON
    sheet.appendRow([
      new Date(),
      evalRecord.propertyName,
      evalRecord.address,
      evalRecord.city,
      evalRecord.state,
      evalRecord.zip,
      evalRecord.date,
      evalRecord.evaluator,
      evalRecord.overallScore,
      evalRecord.gutScore,
      evalRecord.gutLabel,
      evalRecord.askingRate,
      evalRecord.availableSF,
      evalRecord.yearBuilt,
      JSON.stringify(evalRecord)
    ]);

  } catch (err) {
    // Don't fail the whole submission if sheet logging fails
    Logger.log("Sheet logging error: " + err.message);
  }
}
