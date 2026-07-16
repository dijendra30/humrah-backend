const express = require('express');
const router = express.Router();
const adminLaunchRegionController = require('../controllers/adminLaunchRegionController');
const { authenticate, adminOnly } = require('../middleware/auth');

router.use(authenticate, adminOnly);

router.get('/demand', adminLaunchRegionController.getDemand);

router.get('/', adminLaunchRegionController.getAllRegions);
router.post('/', adminLaunchRegionController.createRegion);
router.put('/:id', adminLaunchRegionController.updateRegion);
router.delete('/:id', adminLaunchRegionController.deleteRegion);

module.exports = router;
