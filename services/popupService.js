class PopupService {
  buildPopupResponse(user, regionData, isSupported) {
    if (!regionData) {
      return {
        required: false,
        type: 'NONE',
        version: 0,
        title: null,
        body: null
      };
    }

    const currentVersion = regionData.popupVersion || 1;
    const userSeenVersion = user.popupVersionSeen || 0;
    
    let popupRequired = false;
    let popupType = 'NONE';

    if (!user.launchPopupCompleted) {
      popupRequired = true;
      popupType = isSupported ? 'GENERAL' : 'NEW_USER_UNSUPPORTED';
    } 
    else if (currentVersion > userSeenVersion) {
      popupRequired = true;
      popupType = 'GENERAL';
    }

    // Strictly enforce text matching backend decision
    const fallbackTitleEn = isSupported ? 'Humrah is here!' : 'Coming Soon';
    const fallbackTitleHi = isSupported ? 'हमराह यहाँ है!' : 'जल्द आ रहा है';
    const fallbackBodyEn = isSupported ? 'We are now available in your region.' : 'Humrah is not yet available in your region, but we are expanding fast!';
    const fallbackBodyHi = isSupported ? 'हम अब आपके क्षेत्र में उपलब्ध हैं।' : 'हमराह अभी आपके क्षेत्र में उपलब्ध नहीं है, लेकिन हम तेजी से विस्तार कर रहे हैं!';

    return {
      required: popupRequired,
      type: popupType,
      version: currentVersion,
      title: {
        en: isSupported ? (regionData.popupTitleEn || fallbackTitleEn) : fallbackTitleEn,
        hi: isSupported ? (regionData.popupTitleHi || fallbackTitleHi) : fallbackTitleHi
      },
      body: {
        en: isSupported ? (regionData.popupBodyEn || fallbackBodyEn) : fallbackBodyEn,
        hi: isSupported ? (regionData.popupBodyHi || fallbackBodyHi) : fallbackBodyHi
      }
    };
  }
}

module.exports = new PopupService();
