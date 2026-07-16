class PopupService {
  buildPopupResponse(user, regionData, isSupported) {
    if (!regionData) {
      return {
        popupRequired: false,
        popupType: 'none',
        popupVersion: 0,
        popupTitle: null,
        popupBody: null
      };
    }

    const currentVersion = regionData.popupVersion || 1;
    const userSeenVersion = user.popupVersionSeen || 0;
    
    let popupRequired = false;
    let popupType = 'none';

    if (!user.launchPopupCompleted) {
      popupRequired = true;
      popupType = isSupported ? 'welcome' : 'unsupported';
    } 
    else if (currentVersion > userSeenVersion) {
      popupRequired = true;
      popupType = 'update';
    }

    return {
      popupRequired,
      popupType,
      popupVersion: currentVersion,
      popupTitle: {
        en: regionData.popupTitleEn,
        hi: regionData.popupTitleHi
      },
      popupBody: {
        en: regionData.popupBodyEn,
        hi: regionData.popupBodyHi
      }
    };
  }
}

module.exports = new PopupService();
