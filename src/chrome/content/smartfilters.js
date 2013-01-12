Cu.import("resource:///modules/virtualFolderWrapper.js");

function SmartFilters() {
  var box;
  var msgWindow;
  var folder;
  var locale = Cc["@mozilla.org/intl/stringbundle;1"].
               getService(Ci.nsIStringBundleService).
               createBundle("chrome://smartfilters/locale/smartfilters.properties");
  var preferences = Cc["@mozilla.org/preferences-service;1"]
                       .getService(Ci.nsIPrefService)
                       .getBranch("extensions.smartfilters.");
  var converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
                         .getService(Ci.nsIScriptableUnicodeConverter);
  converter.charset = "UTF-8";

  this.createData = function(folder) {
    var data = {};
    data.myEmails = [];
    data.messages = [];
    // find out all user emails
    var identity = folder.customIdentity;
    if (!identity) {
      var accountManager = Cc["@mozilla.org/messenger/account-manager;1"].getService(Ci.nsIMsgAccountManager);
      var identities = accountManager.allIdentities;
      for (var i = 0; i < identities.Count(); i++) {
        var identity = identities.GetElementAt(i).QueryInterface(Ci.nsIMsgIdentity);
        data.myEmails.push(identity.email);
      }
    } else {
      data.myEmails.push(identity.email);
    }
    // suck out all preferences
    data.filters = [];
    var children = {};
    preferences.getChildList("filter.", children);
    for (var i = 1; i <= children.value; i++) {
      var filter = preferences.getCharPref("filter." + i);
      if (filter == 'nothing')
	continue;
      var patternPref = filter.replace(' ', '.') + ".pattern";
      var prefix = preferences.getCharPref(patternPref);
      data.filters.push({ name : filter, prefix : prefix });
    }
    // load headers for last N messages
    var N = preferences.getIntPref("max.emails.count");
    var dbView = Cc["@mozilla.org/messenger/msgdbview;1?type=quicksearch"].createInstance(Ci.nsIMsgDBView);
    var out = {};
    dbView.open(folder, Ci.nsMsgViewSortType.byDate,
	                Ci.nsMsgViewSortOrder.descending, 
			Ci.nsMsgViewFlagsType.kNone, out);
    var i = 0;
    var headers = [];
    if (out.value > N)
      out.value = N;
    for(var i = 0; i < out.value; i++) {
      headers[i] = dbView.getMsgHdrAt(i);
    }
    dbView.close();
    data.messages = headers.map(function(header) {
      var result = {
        "author"     : [],
        "recipients" : [],
	"subject"    : header.mime2DecodedSubject,
      };
      Util.processAddressListToArray(header.ccList, result.recipients);
      Util.processAddressListToArray(header.recipients, result.recipients);
      Util.processAddressListToArray(header.author, result.author);
      result.messageId = header.messageId.toLowerCase();
      return result;
    });
    return data;
  }
;
  this.start = function() {
    folder = window.arguments[0].folder;
    var worker = new Worker("chrome://smartfilters/content/worker.js");
    worker.postMessage({
        'data' : this.createData(folder),
        'id' : 'start'
    });
    gStatus = document.getElementById("status");
    gProgressMeter = document.getElementById("progressmeter");
    msgWindow = window.arguments[0].msgWindow;
    box = document.getElementById("smartfilters-box");
    document.title = locale.GetStringFromName("title") + " " + folder.URI;
    setStatus("initializing", 0);
    var threshold = preferences.getIntPref("threshold");
    worker.onmessage = function(event) {
      var data = event.data;
      var id = data.id;
      if (id == "end") {
        setStatus("finished", 100);
        return;
      }
      if (id == "test") {
        Application.console.log(data.J + " with K: " + data.K + "  = " + data.diff);
	return;
      }
      setStatus(id + " " + data.postfix, data.percentage);
      // remove `insteadof' children from box
      var arraysEqual = function (arr1, arr2) {
	if(arr1.length !== arr2.length)
	  return false;
	for(var i = arr1.length; i--;) {
	  if(arr1[i] !== arr2[i])
	    return false;
	}
        return true;
      };
      for (var i = 0; i < box.childNodes.length; i++) {
	var child = box.childNodes[i];
	if (arraysEqual(child.data.messageIndices, data.insteadof.messageIndices))
          box.removeChild(child);
      }
      var results = data.results;
      for(var i = 0; i < results.length; i++) {
        var result = results[i];
        // messages not filtered by anything
        if (result.icons.length == 0)
          continue;
        // filter without messages
        if (result.messageIndices.length <= threshold)
          continue;
        box.createRow(result);
      }
    }
  };

  this. selectAll = function(select) {
    var items = box.childNodes;
    for (var i = 0 ; i < items.length; i++) {
      var item = items[i];
      var checkbox = document.getAnonymousElementByAttribute(item,
                                "anonid", "smartfilters-checkbox");
      checkbox.checked = select;
    }
  }

  function createFolders(items) {
    var result = {};
    for (var i = 0 ; i < items.length; i++) {
      var item = items[i];
      var textbox = document.getAnonymousElementByAttribute(item, "anonid", "smartfilters-folder");
      var relativePath = textbox.value;
      var folders = relativePath.split(".");
      var currentFolder = folder;
      for(var j = 0; j < folders.length; j++) {
	var newFolderName = folders[j];
	if (currentFolder.containsChildNamed(newFolderName))
	  currentFolder = currentFolder.getChildNamed(newFolderName);
	else
	  currentFolder = VirtualFolderHelper.createNewVirtualFolder
	    (newFolderName, currentFolder, [folder], [], true).virtualFolder;
      }
      result[relativePath] = 
		VirtualFolderHelper.wrapVirtualFolder(currentFolder);
    }
    return result;
  }

  this.apply = function() {
    var filtersList = folder.getFilterList(null);
    var position = filtersList.filterCount;
    var items = box.childNodes;
    var termCreator = Cc["@mozilla.org/messenger/searchSession;1"]
                      .createInstance(Ci.nsIMsgSearchSession);
    var checkedItems = [];
    for (var i = 0 ; i < items.length; i++) {
      var item = items[i];
      var checkbox = document.getAnonymousElementByAttribute(item,
                                  "anonid", "smartfilters-checkbox");
      if (!checkbox.checked)
        continue;
      checkedItems.push(item);
    }

    var folders = createFolders(checkedItems);
    for (var i = 0 ; i < checkedItems.length; i++) {
      var item = checkedItems[i];
      var msg = item.getAttribute("msg");
      var textbox = document.getAnonymousElementByAttribute(item, "anonid", "smartfilters-folder");
      var terms = [];
      var resultTerms = item.data.terms;
      for(var j = 0; j < resultTerms.length; j++) {
	var resultTerm = resultTerms[j];
	var type = resultTerm.type;
	var searchTerm = termCreator.createTerm();
	if (type == 'robot') {
	  searchTerm.attrib = Ci.nsMsgSearchAttrib.Sender;
	  var value = searchTerm.value;
	  value.attrib = searchTerm.attrib;
	  value.str = resultTerm.email;
	  searchTerm.value = value;
	  searchTerm.op = Ci.nsMsgSearchOp.Contains;
	} else if (type == 'mailing.list') {
	  searchTerm.attrib = Ci.nsMsgSearchAttrib.ToOrCC;
	  var value = searchTerm.value;
	  value.attrib = searchTerm.attrib;
	  value.str = resultTerm.email;
	  searchTerm.value = value;
	  searchTerm.op = Ci.nsMsgSearchOp.Contains;
	}
	searchTerm.booleanAnd = true;
	terms.push(searchTerm);
        folders[textbox.value].searchTerms = terms;
      }
    }
//    filtersList.saveToDefaultFile();
//    applyFilters(filtersList);
    close();
  }

  function applyFilters(filtersList) {
    var filterService = Cc["@mozilla.org/messenger/services/filters;1"]
                                  .getService(Ci.nsIMsgFilterService);
    var folders = Cc["@mozilla.org/supports-array;1"]
                                  .createInstance(Ci.nsISupportsArray);
    folders.AppendElement(data.getFolder());
    filterService.applyFiltersToFolders(filtersList, folders, msgWindow);
  }

  function setStatus(text, percentage) {
    gStatus.value = locale.GetStringFromName("status") + text + "...";
    gProgressMeter.value = percentage;
  }
}

const smartfilters = new SmartFilters();
