const generateProfilePreview = (user) => {
    const titles = [
        "Someone worth meeting ✨",
        "A genuine companion awaits",
        "Your next conversation starts here",
        "Find someone with your vibe",
        "Meet beyond the screen",
        "Discover a meaningful connection",
        "A friendly face awaits",
        "Someone nearby shares your interests",
        "Real people. Real conversations.",
        "Find your next meetup",
        "Looking for genuine company?",
        "A new friendship could begin today",
        "Meet someone who shares your vibe",
        "Discover authentic companionship",
        "A wonderful conversation awaits",
        "Find your next companion",
        "Explore meaningful connections",
        "Someone interesting is nearby",
        "Authentic connections start here",
        "Discover your next meetup buddy",
        "Meet someone new today",
        "A genuine connection awaits",
        "Friendship starts with one hello",
        "Discover a shared vibe",
        "Meet someone who understands you",
        "Your next great conversation",
        "Find real companionship",
        "Someone you should meet",
        "A beautiful connection awaits",
        "Discover real people nearby"
    ];

    const descriptions = [
        "Discover their vibe and interests.",
        "Friendship starts with one hello.",
        "See what makes them unique.",
        "Coffee, walks and meaningful conversations.",
        "Find someone to explore your city with.",
        "You may have more in common than you think.",
        "Every connection begins somewhere.",
        "Discover genuine companionship nearby.",
        "Explore shared interests and hobbies.",
        "Meet verified community members.",
        "Find your next companion.",
        "Meaningful conversations start here.",
        "Because nobody deserves to feel alone.",
        "Discover authentic people nearby.",
        "Start your next meetup today.",
        "See if you share a vibe.",
        "Find someone who matches your energy.",
        "Discover a new friend today.",
        "Explore their profile and interests.",
        "Meaningful connections await.",
        "Connect with someone genuine.",
        "Meet someone for your next adventure.",
        "Discover someone who loves what you love.",
        "A friendly face is just a tap away.",
        "See their interests and bio.",
        "Find a companion for your next outing.",
        "Start a genuine conversation.",
        "Discover true companionship.",
        "Explore authentic profiles nearby.",
        "Someone interesting is waiting to connect."
    ];

    const contextMap = [
        {
            keywords: ['coffee', 'cafe', 'tea'],
            title: "Coffee companion wanted ☕",
            description: "Discover someone who enjoys café conversations."
        },
        {
            keywords: ['walk', 'walking', 'park', 'hike'],
            title: "Ready for a walk?",
            description: "Meet someone who loves exploring together."
        },
        {
            keywords: ['movie', 'movies', 'cinema', 'film'],
            title: "Movie buddy nearby 🍿",
            description: "Discover someone who enjoys cinema nights."
        },
        {
            keywords: ['study', 'reading', 'book', 'library'],
            title: "Study together 📚",
            description: "Meet someone looking for a study partner."
        },
        {
            keywords: ['sport', 'sports', 'gym', 'workout', 'fitness'],
            title: "Activity partner wanted",
            description: "Shared hobbies create stronger friendships."
        },
        {
            keywords: ['food', 'eating', 'restaurant', 'dining'],
            title: "Foodie companion nearby 🍕",
            description: "Discover someone to share a great meal with."
        },
        {
            keywords: ['travel', 'trip', 'explore'],
            title: "Travel buddy nearby ✈️",
            description: "Meet someone who loves exploring new places."
        },
        {
            keywords: ['music', 'concert', 'listen'],
            title: "Music lover nearby 🎵",
            description: "Discover someone who shares your music taste."
        },
        {
            keywords: ['game', 'gaming', 'play'],
            title: "Gaming buddy wanted 🎮",
            description: "Meet someone who enjoys gaming together."
        }
    ];

    const name = user.firstName ? user.firstName.trim() : 'Someone';
    
    const seedString = user._id ? user._id.toString() : 'default';
    let seed = 0;
    for (let i = 0; i < seedString.length; i++) {
        seed = (seed << 5) - seed + seedString.charCodeAt(i);
        seed |= 0; 
    }
    const absSeed = Math.abs(seed);

    let finalTitle = null;
    let finalDesc = null;

    if (user.questionnaire) {
        const interests = [
            ...(user.questionnaire.interests || []),
            ...(user.questionnaire.hobbies || []),
            ...(user.questionnaire.hangoutPreferences || []),
            ...(user.questionnaire.comfortActivity || [])
        ].join(' ').toLowerCase();

        for (const context of contextMap) {
            for (const keyword of context.keywords) {
                if (interests.includes(keyword)) {
                    finalTitle = context.title;
                    finalDesc = context.description;
                    break;
                }
            }
            if (finalTitle) break;
        }
    }

    if (!finalTitle || !finalDesc) {
        const titleIndex = absSeed % titles.length;
        const descIndex = absSeed % descriptions.length;
        
        let rawTitle = titles[titleIndex];
        if (user.isCompanion && absSeed % 3 === 0) {
            rawTitle = "Meet a Community Companion";
        } else if (rawTitle.includes('{name}')) {
            rawTitle = rawTitle.replace('{name}', name);
        } else if (absSeed % 4 === 0) {
            rawTitle = `Meet ${name} 👋`;
        } else if (absSeed % 5 === 0) {
            rawTitle = `Discover ${name}`;
        }

        finalTitle = rawTitle;
        finalDesc = descriptions[descIndex];
    }

    return {
        title: finalTitle,
        description: finalDesc,
        image: user.profilePhotoUrl || 'https://humrah.in/assets/humrah-community-banner.png',
        url: `https://humrah.in/profile/${user._id}`
    };
};

const generatePostPreview = (post) => {
    const postTitles = [
        "A moment shared on Humrah ✨",
        "Check out this post",
        "Join the conversation",
        "Someone shared an update",
        "A new post to explore",
        "See what's happening on Humrah",
        "Discover this moment",
        "A community update",
        "Explore this post",
        "Someone shared something special"
    ];

    const authorName = post.userId ? `${post.userId.firstName} ${post.userId.lastName}`.trim() : 'Someone';
    
    const seedString = post._id ? post._id.toString() : 'default';
    let seed = 0;
    for (let i = 0; i < seedString.length; i++) {
        seed = (seed << 5) - seed + seedString.charCodeAt(i);
        seed |= 0; 
    }
    const absSeed = Math.abs(seed);

    let rawTitle = postTitles[absSeed % postTitles.length];
    
    if (absSeed % 3 === 0 && authorName !== 'Someone') {
        rawTitle = `${authorName} shared a post ✨`;
    } else if (absSeed % 4 === 0 && authorName !== 'Someone') {
        rawTitle = `See what ${authorName} is up to`;
    }

    let finalDesc = "Join Humrah to see this post and connect with the community.";
    
    if (post.caption && post.caption.trim().length > 0) {
        finalDesc = post.caption.trim().substring(0, 97);
        if (post.caption.length > 97) finalDesc += '...';
    }

    return {
        title: rawTitle,
        description: finalDesc,
        image: post.imageUrl || 'https://humrah.in/assets/humrah-community-banner.png',
        url: `https://humrah.in/post/${post._id}`
    };
};

module.exports = {
    generateProfilePreview,
    generatePostPreview
};
